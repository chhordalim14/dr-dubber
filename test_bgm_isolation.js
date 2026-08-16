const fs = require('fs');

async function testBgm() {
    const fileBuffer = fs.readFileSync("C:/Software/DAI-Dubber-PRO/episode.mp4");
    const fileBlob = new Blob([fileBuffer], { type: "video/mp4" });
    
    const form = new FormData();
    const jobId = "test_bgm_" + Date.now();
    form.append("jobId", jobId);
    form.append("videoFile", fileBlob, "episode.mp4");

    console.log("Submitting BGM isolation job...");
    const res = await fetch("http://localhost:3001/api/remove-vocals", {
        method: "POST",
        body: form
    });
    const init = await res.json();
    console.log("Initial response:", init);

    // Poll until done
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const check = await fetch(`http://localhost:3001/api/bgm-job-status?jobId=${jobId}`);
        const status = await check.json();
        console.log(`Poll ${i + 1}: status =`, status.status, "success =", status.success);
        if (status.status === "done") {
            console.log("SUCCESS! BGM Isolation result:", JSON.stringify(status, null, 2));
            break;
        }
    }
}

testBgm();
