const fs = require('fs');
const path = require('path');

const indexHtml = fs.readFileSync(path.join(__dirname, 'frontend', 'index.html'), 'utf8');

const lastScriptIdx = indexHtml.lastIndexOf('<script>');
const lastScriptEnd = indexHtml.lastIndexOf('</script>');
const code = indexHtml.substring(lastScriptIdx + 8, lastScriptEnd);

console.log(`Inline script length: ${code.length} characters.`);
try {
    new Function(code);
    console.log("Inline script syntax: OK!");
} catch (e) {
    console.error("INLINE SCRIPT SYNTAX ERROR:", e.message);
    console.error(e.stack);
}
