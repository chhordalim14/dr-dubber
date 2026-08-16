async function testStreamVideo() {
    const videoPath = 'C:\\Software\\DAI-Dubber-PRO\\episode.mp4';
    const url = `http://localhost:3001/api/audio?path=${encodeURIComponent(videoPath)}`;
    console.log("Testing stream from:", url);
    
    // Normal request
    const res = await fetch(url);
    console.log("Full request status:", res.status, "content-type:", res.headers.get("content-type"), "content-length:", res.headers.get("content-length"));
    
    // Range request (used by HTML5 <video> elements)
    const rangeRes = await fetch(url, {
        headers: { "Range": "bytes=0-1024" }
    });
    console.log("Range request status:", rangeRes.status, "content-range:", rangeRes.headers.get("content-range"), "content-length:", rangeRes.headers.get("content-length"));
}

testStreamVideo();
