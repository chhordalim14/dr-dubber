const testPayload = {
    text: "ការងារនេះខ្ញុំធ្វើឡើងដោយក្ដីស្រឡាញ់ និងការលះបង់ខ្ពស់។",
    gender: "Male",
    language: "Khmer",
    tempPath: "C:\\Temp\\AIDubber",
    index: "sub-1",
    speed: 1.0
};

async function test() {
    try {
        const res = await fetch("http://localhost:3001/api/generate-audio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(testPayload)
        });
        const data = await res.json();
        console.log("Response from /api/generate-audio:", data);
    } catch (e) {
        console.error("Fetch error:", e);
    }
}

test();
