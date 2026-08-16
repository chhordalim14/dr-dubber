// DR Dubber Pro Core Helper
window.VOXCMP2_KEY = "voxcmp2_settings";

function _lucideCreateIcons(opts) {
    try {
        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons(opts);
        }
    } catch (e) {}
}
window._lucideCreateIcons = _lucideCreateIcons;

document.addEventListener('DOMContentLoaded', () => {
    _lucideCreateIcons();
});