async function testExtractAndDownload() {
    console.log("1. Calling /api/extract-audio...");
    const res = await fetch("http://localhost:3001/api/extract-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoPath: "C:/Software/DAI-Dubber-PRO/episode.mp4" })
    });
    const data = await res.json();
    console.log("Extraction response:", data);

    console.log("2. Testing browser download URL:", `http://localhost:3001${data.url}`);
    const dlRes = await fetch(`http://localhost:3001${data.url}`);
    console.log("Download response status:", dlRes.status, dlRes.headers.get("content-type"), "size:", dlRes.headers.get("content-length"));
}

testExtractAndDownload();
