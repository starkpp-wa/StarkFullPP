import express from "express";
import multer from "multer";
import pino from "pino";

import {
    mkdir,
    rm
} from "fs/promises";

import {
    randomBytes
} from "crypto";

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} from "@whiskeysockets/baileys";

import { updateFullPP } from "./fullpp.js";


// ========================================
// CONFIG
// ========================================

const app = express();

const PORT =
    process.env.PORT || 3000;

const SESSIONS_DIR =
    "./sessions";

const MAX_SESSIONS =
    3;

const SESSION_TIMEOUT_MS =
    10 * 60 * 1000;

const SESSION_COOKIE =
    "starkpp_session";


// ========================================
// EXPRESS
// ========================================

app.use(express.json());


// ========================================
// UPLOAD
// ========================================

const upload =
    multer({
        storage:
            multer.memoryStorage(),

        limits: {
            fileSize:
                15 * 1024 * 1024
        }
    });


// ========================================
// SESSION STORE
// ========================================

const sessions =
    new Map();


// ========================================
// COOKIE HELPERS
// ========================================

function getSessionToken(req) {

    const cookieHeader =
        req.headers.cookie || "";

    const cookies =
        cookieHeader
            .split(";")
            .map(
                item => item.trim()
            )
            .filter(Boolean);

    for (const cookie of cookies) {

        const separator =
            cookie.indexOf("=");

        if (separator === -1) {
            continue;
        }

        const name =
            cookie.slice(
                0,
                separator
            );

        const value =
            cookie.slice(
                separator + 1
            );

        if (
            name ===
            SESSION_COOKIE
        ) {
            return value;
        }
    }

    return null;
}


function createToken() {

    return randomBytes(32)
        .toString("hex");
}


function setSessionCookie(
    res,
    token
) {

    let cookie =
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;

    const isHttps =
        process.env.NODE_ENV === "production" ||
        process.env.RENDER === "true";

    if (isHttps) {
        cookie += "; Secure";
    }

    res.setHeader(
        "Set-Cookie",
        cookie
    );
}


// ========================================
// SESSION MIDDLEWARE
// ========================================

app.use(
    (req, res, next) => {

        let token =
            getSessionToken(req);

        if (!token) {

            token =
                createToken();

            setSessionCookie(
                res,
                token
            );
        }

        req.sessionToken =
            token;

        next();
    }
);


// ========================================
// STATIC WEBSITE
// ========================================

app.use(
    express.static("public")
);


// ========================================
// DELETE SESSION AUTH
// ========================================

async function deleteSessionDirectory(
    session
) {

    try {

        await rm(
            session.authDir,
            {
                recursive:
                    true,

                force:
                    true
            }
        );

        console.log(
            `Session ${session.id}: auth deleted.`
        );

    } catch (error) {

        console.error(
            `Session ${session.id}: auth cleanup failed:`,
            error
        );
    }
}


// ========================================
// SESSION TIMER
// ========================================

function clearSessionTimer(
    session
) {

    if (
        session.timer
    ) {

        clearTimeout(
            session.timer
        );

        session.timer =
            null;
    }
}


function resetSessionTimer(
    session
) {

    clearSessionTimer(
        session
    );

    session.timer =
        setTimeout(
            async () => {

                console.log(
                    `Session ${session.id}: timed out.`
                );

                await endSession(
                    session,
                    true
                );

            },
            SESSION_TIMEOUT_MS
        );
}


// ========================================
// CREATE SESSION
// ========================================

function createSession(
    token
) {

    const sessionId =
        randomBytes(12)
            .toString("hex");

    const session = {

        id:
            sessionId,

        token,

        authDir:
            `${SESSIONS_DIR}/${sessionId}`,

        client:
            null,

        connected:
            false,

        socketReady:
            false,

        pairingCode:
            null,

        phoneNumber:
            null,

        pairingRequested:
            false,

        restarting:
            false,

        cleaning:
            false,

        ended:
            false,

        timer:
            null,

        qrPromise:
            null,

        qrResolve:
            null,

        createdAt:
            Date.now(),

        lastActivity:
            Date.now()
    };

    sessions.set(
        token,
        session
    );

    return session;
}


// ========================================
// START SOCKET
// ========================================

async function startSessionSocket(
    session
) {

    if (
        session.ended ||
        session.cleaning
    ) {

        throw new Error(
            "Session is no longer active."
        );
    }


    await mkdir(
        session.authDir,
        {
            recursive:
                true
        }
    );


    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            session.authDir
        );


    // Promise used only by the initial
    // pairing-code request.

    let resolveQR;

    session.qrPromise =
        new Promise(
            resolve => {
                resolveQR =
                    resolve;
            }
        );

    session.qrResolve =
        resolveQR;


    const client =
        makeWASocket({

            auth:
                state,

            browser:
                Browsers.macOS(
                    "Safari"
                ),

            printQRInTerminal:
                false,

            logger:
                pino({
                    level:
                        "silent"
                })
        });


    session.client =
        client;


    client.ev.on(
        "creds.update",
        saveCreds
    );


    client.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect,
                qr
            } =
                update;


            // ==================================
            // QR READY
            // ==================================

            if (qr) {

                session.socketReady =
                    true;


                if (
                    session.qrResolve
                ) {

                    session.qrResolve(
                        qr
                    );

                    session.qrResolve =
                        null;
                }


                console.log(
                    `Session ${session.id}: pairing socket ready.`
                );
            }


            // ==================================
            // CONNECTED
            // ==================================

            if (
                connection ===
                "open"
            ) {

                // Ignore events from an old
                // socket after a restart.

                if (
                    session.client !==
                    client
                ) {

                    return;
                }


                session.connected =
                    true;

                session.socketReady =
                    true;

                session.restarting =
                    false;

                session.pairingCode =
                    null;


                console.log(
                    `✅ Session ${session.id}: WhatsApp connected.`
                );


                resetSessionTimer(
                    session
                );
            }


            // ==================================
            // CLOSED
            // ==================================

            if (
                connection ===
                "close"
            ) {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;


                console.log(
                    `Session ${session.id}: connection closed (${statusCode}).`
                );


                // Old socket event?
                // Ignore it.

                if (
                    session.client !==
                    client
                ) {

                    return;
                }


                session.connected =
                    false;

                session.socketReady =
                    false;

                session.client =
                    null;


                if (
                    session.cleaning ||
                    session.ended
                ) {

                    return;
                }


                // ==================================
                // 515 = RESTART REQUIRED
                // ==================================

                if (
                    statusCode ===
                    DisconnectReason.restartRequired
                ) {

                    if (
                        session.restarting
                    ) {

                        return;
                    }


                    session.restarting =
                        true;


                    console.log(
                        `Session ${session.id}: 515 restart required. Keeping auth.`
                    );


                    setTimeout(
                        async () => {

                            if (
                                session.ended ||
                                session.cleaning
                            ) {

                                return;
                            }


                            try {

                                await startSessionSocket(
                                    session
                                );


                                session.restarting =
                                    false;


                                console.log(
                                    `Session ${session.id}: socket restarted with same auth.`
                                );


                            } catch (error) {

                                session.restarting =
                                    false;


                                console.error(
                                    `Session ${session.id}: restart failed:`,
                                    error
                                );


                                await endSession(
                                    session,
                                    false
                                );
                            }

                        },
                        1000
                    );


                    return;
                }


                // ==================================
                // LOGGED OUT
                // ==================================

                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {

                    await endSession(
                        session,
                        false
                    );


                    return;
                }


                // ==================================
                // OTHER DISCONNECT
                // ==================================

                console.log(
                    `Session ${session.id}: unexpected disconnect.`
                );


                setTimeout(
                    async () => {

                        if (
                            session.ended ||
                            session.cleaning
                        ) {

                            return;
                        }


                        try {

                            await startSessionSocket(
                                session
                            );


                            console.log(
                                `Session ${session.id}: socket reconnected.`
                            );


                        } catch (error) {

                            console.error(
                                `Session ${session.id}: reconnect failed:`,
                                error
                            );


                            await endSession(
                                session,
                                false
                            );
                        }

                    },
                    3000
                );
            }

        }
    );


    return {
        client,
        state
    };
}


// ========================================
// END SESSION
// ========================================

async function endSession(
    session,
    logout = false
) {

    if (
        !session ||
        session.ended ||
        session.cleaning
    ) {

        return;
    }


    session.cleaning =
        true;


    clearSessionTimer(
        session
    );


    console.log(
        `Session ${session.id}: cleaning up...`
    );


    try {

        if (
            logout &&
            session.client
        ) {

            try {

                await session.client.logout();

                console.log(
                    `Session ${session.id}: logout requested.`
                );

            } catch (error) {

                console.log(
                    `Session ${session.id}: logout result:`,
                    error?.message ||
                    error
                );
            }
        }

    } finally {

        session.ended =
            true;

        session.client =
            null;

        session.connected =
            false;

        session.socketReady =
            false;

        session.pairingCode =
            null;


        sessions.delete(
            session.token
        );


        await deleteSessionDirectory(
            session
        );


        session.cleaning =
            false;


        console.log(
            `✅ Session ${session.id}: released.`
        );
    }
}


// ========================================
// STATUS
// ========================================

app.get(
    "/api/status",
    async (req, res) => {

        const session =
            sessions.get(
                req.sessionToken
            );


        const activeCount =
            sessions.size;


        // ==================================
        // THIS USER HAS A SESSION
        // ==================================

        if (session) {

            session.lastActivity =
                Date.now();


            return res.json({

                connected:
                    session.connected,

                owner:
                    true,

                hasSession:
                    true,

                activeCount,

                maxSessions:
                    MAX_SESSIONS,

                ready:
                    false,

                pairingCode:
                    session.pairingCode,

                busy:
                    false
            });
        }


        // ==================================
        // NEW USER
        // ==================================

        return res.json({

            connected:
                false,

            owner:
                false,

            hasSession:
                false,

            activeCount,

            maxSessions:
                MAX_SESSIONS,

            ready:
                activeCount <
                MAX_SESSIONS,

            pairingCode:
                null,

            busy:
                activeCount >=
                MAX_SESSIONS
        });
    }
);


// ========================================
// PAIRING CODE
// ========================================

app.post(
    "/api/pair",
    async (req, res) => {

        const token =
            req.sessionToken;


        let session =
            sessions.get(
                token
            );


        // ==================================
        // EXISTING SESSION
        // ==================================

        if (session) {

            if (
                session.connected
            ) {

                return res.status(409).json({

                    ok:
                        false,

                    error:
                        "WhatsApp is already connected."
                });
            }


            if (
                session.pairingCode
            ) {

                return res.json({

                    ok:
                        true,

                    code:
                        session.pairingCode
                });
            }


            if (
                session.pairingRequested
            ) {

                return res.status(409).json({

                    ok:
                        false,

                    error:
                        "Pairing is already in progress."
                });
            }
        }


        // ==================================
        // SESSION LIMIT
        // ==================================

        if (
            !session &&
            sessions.size >=
                MAX_SESSIONS
        ) {

            return res.status(429).json({

                ok:
                    false,

                error:
                    "Maximum active users reached. Please try again later."
            });
        }


        // ==================================
        // PHONE NUMBER
        // ==================================

        const number =
            String(
                req.body?.number ||
                ""
            )
            .replace(
                /\D/g,
                ""
            );


        if (
            number.length < 8 ||
            number.length > 15
        ) {

            return res.status(400).json({

                ok:
                    false,

                error:
                    "Enter a valid international phone number with country code."
            });
        }


        // ==================================
        // CREATE SESSION
        // ==================================

        if (!session) {

            session =
                createSession(
                    token
                );
        }


        session.phoneNumber =
            number;

        session.pairingRequested =
            true;

        session.lastActivity =
            Date.now();


        resetSessionTimer(
            session
        );


        try {

            // ==================================
            // CREATE SOCKET
            // ==================================

            await startSessionSocket(
                session
            );


            // ==================================
            // WAIT FOR QR EVENT
            // ==================================
            //
            // We don't display the QR.
            // We use it only as the signal that
            // WhatsApp is ready for pairing code.
            //

            await Promise.race([

                session.qrPromise,

                new Promise(
                    (_, reject) => {

                        setTimeout(
                            () => {

                                reject(
                                    new Error(
                                        "Timed out waiting for WhatsApp pairing readiness."
                                    )
                                );

                            },
                            15000
                        );
                    }
                )

            ]);


            // ==================================
            // REQUEST PAIRING CODE
            // ==================================

            const code =
                await session.client
                    .requestPairingCode(
                        number
                    );


            session.pairingCode =
                code;

            session.pairingRequested =
                false;


            console.log(
                `Session ${session.id}: PAIRING CODE ${code}`
            );


            resetSessionTimer(
                session
            );


            return res.json({

                ok:
                    true,

                code
            });


        } catch (error) {

            console.error(
                `Session ${session.id}: pairing error:`,
                error
            );


            await endSession(
                session,
                false
            );


            return res.status(500).json({

                ok:
                    false,

                error:
                    error?.message ||
                    "Failed to generate pairing code."
            });
        }
    }
);


// ========================================
// UPDATE PROFILE PICTURE
// ========================================

app.post(
    "/api/update-pp",
    upload.single("image"),

    async (req, res) => {

        const session =
            sessions.get(
                req.sessionToken
            );


        // ==================================
        // SESSION CHECK
        // ==================================

        if (!session) {

            return res.status(403).json({

                ok:
                    false,

                error:
                    "Your session has expired."
            });
        }


        // ==================================
        // CONNECTION CHECK
        // ==================================

        if (
            !session.connected ||
            !session.client
        ) {

            return res.status(400).json({

                ok:
                    false,

                error:
                    "WhatsApp is not connected."
            });
        }


        // ==================================
        // IMAGE CHECK
        // ==================================

        if (!req.file) {

            return res.status(400).json({

                ok:
                    false,

                error:
                    "Please select an image."
            });
        }


        try {

            console.log(
                `Session ${session.id}: updating profile picture...`
            );


            await updateFullPP(
                req.file.buffer,
                session.client
            );


            console.log(
                `✅ Session ${session.id}: profile picture updated.`
            );


            // ==================================
            // LOGOUT + CLEANUP
            // ==================================

            await endSession(
                session,
                true
            );


            return res.json({

                ok:
                    true,

                message:
                    "Profile picture updated successfully."
            });


        } catch (error) {

            console.error(
                `Session ${session.id}: PP update failed:`,
                error
            );


            return res.status(500).json({

                ok:
                    false,

                error:
                    error?.message ||
                    "Profile picture update failed."
            });
        }
    }
);


// ========================================
// START SERVER
// ========================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `StarkFullPP running on port ${PORT}`
        );

        console.log(
            `Maximum simultaneous sessions: ${MAX_SESSIONS}`
        );
    }
);