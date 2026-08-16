const fs = require('fs');

async function testTranscribe() {
    // Generate a dummy 3-second audio payload
    const dummyAudioBase64 = Buffer.from("RIFF....WAVEfmt ....data....").toString('base64');
    
    console.log("Testing /api/transcribe...");
    const res = await fetch("http://localhost:3001/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            audioBase64: dummyAudioBase64,
            mimeType: "audio/mp3",
            duration: 5.0,
            targetLanguage: "Khmer",
            apiKey: "TEST_KEY_DEMO",
            model: "gemini-2.0-flash",
            requestId: "req_test"
        })
    });
    
    const data = await res.json();
    console.log("Transcribe response:", data);
    
    // Check if chunk file was written to outputs folder
    const files = fs.readdirSync('storage/outputs');
    console.log("Outputs folder contents:", files);
}

testTranscribe();
