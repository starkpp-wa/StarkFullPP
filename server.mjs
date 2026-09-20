import express from "express";
import multer from "multer";
import pino from "pino";
import { rm } from "fs/promises";

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} from "@whiskeysockets/baileys";

import { updateFullPP } from "./fullpp.js";

const app = express();

const PORT = process.env.PORT || 3000;
const AUTH_DIR = "./auth";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 15 * 1024 * 1024
    }
});

app.use(express.json());
app.use(express.static("public"));


// ========================================
// STATE
// ========================================

let client = null;

let connected = false;
let busy = false;

let socketReady = false;

let pairingCode = null;

let starting = false;
let cleaningUp = false;

let sessionTimer = null;


// ========================================
// DELETE AUTH
// ========================================

async function deleteAuth() {
    try {
        await rm(AUTH_DIR, {
            recursive: true,
            force: true
        });

        console.log("Auth directory deleted.");

    } catch (error) {

        console.error(
            "Auth cleanup failed:",
            error
        );
    }
}


// ========================================
// SESSION TIMEOUT
// ========================================

function clearSessionTimer() {

    if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
    }
}


function startSessionTimer() {

    clearSessionTimer();

    sessionTimer = setTimeout(
        async () => {

            console.log(
                "Pairing session timed out."
            );

            await finishSession();

        },
        10 * 60 * 1000
    );
}


// ========================================
// FINISH SESSION
// ========================================

async function finishSession() {

    if (cleaningUp) {
        return;
    }

    cleaningUp = true;

    clearSessionTimer();

    const currentClient = client;

    console.log(
        "Finishing temporary WhatsApp session..."
    );


    try {

        if (currentClient) {

            try {

                await currentClient.logout();

                console.log(
                    "WhatsApp logout requested."
                );

            } catch (error) {

                console.log(
                    "Logout returned:",
                    error?.message || error
                );
            }
        }

    } finally {

        client = null;

        connected = false;
        busy = false;
        socketReady = false;

        pairingCode = null;


        await deleteAuth();

        cleaningUp = false;


        console.log(
            "Session cleanup complete."
        );


        setTimeout(
            () => {
                startWhatsApp();
            },
            1500
        );
    }
}


// ========================================
// STATUS
// ========================================

app.get(
    "/api/status",
    (_req, res) => {

        res.json({
            connected,
            busy,
            ready: socketReady,
            pairingCode
        });
    }
);


// ========================================
// REQUEST PAIRING CODE
// ========================================

app.post(
    "/api/pair",
    async (req, res) => {

        try {

            if (busy) {

                return res.status(409).json({
                    ok: false,
                    error:
                        "Another session is already active."
                });
            }


            if (connected) {

                return res.status(409).json({
                    ok: false,
                    error:
                        "WhatsApp is already connected."
                });
            }


            if (!client) {

                return res.status(503).json({
                    ok: false,
                    error:
                        "WhatsApp socket is not ready."
                });
            }


            if (!socketReady) {

                return res.status(503).json({
                    ok: false,
                    error:
                        "WhatsApp connection is still starting. Try again in a moment."
                });
            }


            let number =
                String(
                    req.body?.number || ""
                )
                .replace(/\D/g, "");


            if (
                number.length < 8 ||
                number.length > 15
            ) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Enter a valid international phone number."
                });
            }


            busy = true;


            console.log(
                `Requesting pairing code for ${number}`
            );


            const code =
                await client.requestPairingCode(
                    number
                );


            pairingCode = code;


            console.log(
                `PAIRING CODE: ${code}`
            );


            startSessionTimer();


            return res.json({
                ok: true,
                code
            });


        } catch (error) {

            busy = false;
            pairingCode = null;

            console.error(
                "Pairing-code error:",
                error
            );


            return res.status(500).json({
                ok: false,
                error:
                    error?.message ||
                    "Could not generate pairing code."
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

        try {

            if (!connected || !client) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "WhatsApp is not connected."
                });
            }


            if (!req.file) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Please select an image."
                });
            }


            console.log(
                "Updating profile picture..."
            );


            await updateFullPP(
                req.file.buffer,
                client
            );


            console.log(
                "Profile picture updated."
            );


            // Only AFTER successful PP update
            // do we destroy the session.

            await finishSession();


            return res.json({
                ok: true,
                message:
                    "Profile picture updated successfully."
            });


        } catch (error) {

            console.error(
                "Profile-picture update error:",
                error
            );


            return res.status(500).json({
                ok: false,
                error:
                    error?.message ||
                    "Profile-picture update failed."
            });
        }
    }
);


// ========================================
// WHATSAPP
// ========================================

async function startWhatsApp() {

    if (starting || client || cleaningUp) {
        return;
    }

    starting = true;

    try {

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            AUTH_DIR
        );


        client = makeWASocket({

            auth: state,

            browser:
                Browsers.macOS("Safari"),

            printQRInTerminal: false,

            logger:
                pino({
                    level: "silent"
                })
        });


        client.ev.on(
            "creds.update",
            async (creds) => {

                await saveCreds(creds);


                // WhatsApp has completed
                // registration/linking.

                if (
                    creds.registered === true
                ) {

                    console.log(
                        "WhatsApp credentials are now registered."
                    );
                }
            }
        );


        client.ev.on(
            "connection.update",
            async (update) => {

                const {
                    connection,
                    lastDisconnect
                } = update;


                // ==================================
                // CONNECTION READY
                // ==================================

                if (
                    connection === "connecting"
                ) {

                    socketReady = true;

                    console.log(
                        "WhatsApp socket ready."
                    );
                }


                // ==================================
                // CONNECTED
                // ==================================

                if (
                    connection === "open"
                ) {

                    connected = true;
                    socketReady = true;
                    starting = false;

                    pairingCode = null;

                    console.log(
                        "✅ WhatsApp connected!"
                    );
                }


                // ==================================
                // CLOSED
                // ==================================

                if (
                    connection === "close"
                ) {

                    const statusCode =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;


                    console.log(
                        `WhatsApp connection closed. Status: ${statusCode}`
                    );


                    connected = false;
                    socketReady = false;

                    const currentClient =
                        client;


                    client = null;


                    if (cleaningUp) {
                        return;
                    }


                    // ==============================
                    // LOGGED OUT
                    // ==============================

                    if (
                        statusCode ===
                        DisconnectReason.loggedOut
                    ) {

                        console.log(
                            "WhatsApp session logged out."
                        );


                        busy = false;
                        pairingCode = null;

                        await deleteAuth();


                        setTimeout(
                            () => {
                                startWhatsApp();
                            },
                            1500
                        );


                        return;
                    }


                    // ==============================
                    // NORMAL CONNECTION FAILURE
                    // ==============================

                    if (currentClient) {

                        console.log(
                            "Temporary connection failure."
                        );
                    }


                    // IMPORTANT:
                    // DO NOT delete auth here.
                    //
                    // The pairing process may still
                    // need those credentials.


                    setTimeout(
                        () => {
                            startWhatsApp();
                        },
                        2000
                    );
                }

            }
        );


        starting = false;


    } catch (error) {

        starting = false;

        console.error(
            "WhatsApp startup error:",
            error
        );


        // Don't destroy auth automatically.

        setTimeout(
            () => {
                startWhatsApp();
            },
            3000
        );
    }
}


// ========================================
// START SERVER
// ========================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Web UI running on port ${PORT}`
        );

        startWhatsApp();
    }
);