import { Jimp } from "jimp";


// ========================================
// PREPARE IMAGE
// ========================================

async function generateProfilePicture(buffer) {

    const image =
        await Jimp.read(buffer);


    // Keep the complete original aspect ratio.
    // Scale it to fit inside 324x720.

    image.scaleToFit({
        w: 324,
        h: 720
    });


    const img =
        await image.getBuffer(
            "image/jpeg",
            {
                quality: 90
            }
        );


    return {
        img
    };
}


// ========================================
// UPDATE FULL PROFILE PICTURE
// ========================================

export async function updateFullPP(
    imageBuffer,
    client
) {

    const {
        img
    } = await generateProfilePicture(
        imageBuffer
    );


    await client.query({

        tag: "iq",

        attrs: {
            to: "@s.whatsapp.net",
            type: "set",
            xmlns: "w:profile:picture"
        },

        content: [

            {
                tag: "picture",

                attrs: {
                    type: "image"
                },

                content: img
            }

        ]

    });
}