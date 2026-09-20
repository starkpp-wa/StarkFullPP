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


const app = express();


const PORT =
    process.env.PORT || 3000;


// ========================================
// CONFIG
// ========================================

const SESSIONS_DIR =
    "./sessions";


// Maximum simultaneous WhatsApp users.
//
// Change this later if necessary.

const MAX_SESSIONS = 3;


// How long an unused session may live.

const SESSION_TIMEOUT_MS =
    10 * 60 * 1000;


// Browser cookie name.

const SESSION_COOKIE =
    "starkpp_session";


// ========================================
// EXPRESS
// ========================================

app.use(
    express.json()
);


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
//
// Every browser/user gets a unique token.
//
// Map:
// token -> session
//
// ========================================

const sessions =
    new Map();


// ========================================
// COOKIE
// ========================================

function getSessionToken(req) {

    const cookieHeader =
        req.headers.cookie || "";


    const cookies =
        cookieHeader
            .split(";")
            .map(
                item =>
                    item.trim()
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


// ========================================
// CREATE RANDOM TOKEN
// ========================================

function createToken() {

    return randomBytes(32)
        .toString("hex");
}


// ========================================
// SET COOKIE
// ========================================

function setSessionCookie(
    res,
    token
) {

    let cookie =
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;


    if (
        process.env.RENDER ===
        "true"
    ) {

        cookie +=
            "; Secure";
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
// DELETE SESSION DIRECTORY
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

        cleaning:
            false,

        ended:
            false,

        timer:
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
// START BAILEYS FOR SESSION
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
                lastDisconnect
            } =
                update;


            // ==================================
            // CONNECTING
            // ==================================

            if (
                connection ===
                "connecting"
            ) {

                session.socketReady =
                    true;


                console.log(
                    `Session ${session.id}: socket ready.`
                );
            }


            // ==================================
            // CONNECTED
            // ==================================

            if (
                connection ===
                "open"
            ) {

                session.connected =
                    true;

                session.socketReady =
                    true;

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


                // If WhatsApp deliberately
                // logged the user out, destroy
                // the session.

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


                // Any unexpected disconnect:
                //
                // Give this session a short chance
                // to recover. If it doesn't, destroy
                // the temporary session.

                setTimeout(
                    async () => {

                        if (
                            session.ended ||
                            session.cleaning
                        ) {
                            return;
                        }


                        console.log(
                            `Session ${session.id}: connection lost, ending session.`
                        );


                        await endSession(
                            session,
                            false
                        );

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
    logout
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
                    `Session ${session.id}: WhatsApp logout requested.`
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


        session.cleaning =
            false;


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
        // THIS BROWSER HAS A SESSION
        // ==================================

        if (session) {

            session.lastActivity =
                Date.now();


            resetSessionTimer(
                session
            );


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
                    !session.connected &&
                    !session.pairingRequested &&
                    session.socketReady,

                pairingCode:
                    session.pairingCode,

                busy:
                    false

            });
        }


        // ==================================
        // NEW BROWSER
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
// REQUEST PAIRING CODE
// ========================================

app.post(
    "/api/pair",
    async (req, res) => {

        const token =
            req.sessionToken;


        // ==================================
        // EXISTING SESSION
        // ==================================

        let session =
            sessions.get(
                token
            );


        if (session) {

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
        // MAXIMUM SESSIONS
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
                    "Maximum number of active users reached. Please try again later."

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
            // START SOCKET
            // ==================================

            await startSessionSocket(
                session
            );


            /*
             * Wait until Baileys emits a QR
             * internally.
             *
             * We do NOT expose this QR.
             *
             * This gives requestPairingCode()
             * the socket readiness it expects.
             */

            if (
                !session.connected
            ) {

                try {

                    await session.client
                        .waitForConnectionUpdate(
                            update =>
                                !!update.qr
                        );

                } catch {
                    // Continue below.
                }
            }


            // ==================================
            // REQUEST CODE
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
                true
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
        // SESSION NOT FOUND
        // ==================================

        if (
            !session
        ) {

            return res.status(403).json({

                ok:
                    false,

                error:
                    "Your session has expired."

            });
        }


        session.lastActivity =
            Date.now();


        resetSessionTimer(
            session
        );


        // ==================================
        // NOT CONNECTED
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
        // NO IMAGE
        // ==================================

        if (
            !req.file
        ) {

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


            // ==================================
            // FULL PP
            // ==================================

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
// SERVER
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