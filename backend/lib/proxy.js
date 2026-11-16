// Proxy string parsing and normalization utilities for DR Dubber Pro
// Supports formats:
//   - http://user:pass@host:port
//   - socks5://host:port
//   - host:port:user:pass
//   - host:port
//   - host

function parseProxyString(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim();
    if (!s || s.startsWith('#')) return null;

    let protocol = 'http';
    let username = '';
    let password = '';
    let host = '';
    let port = 8080;

    const protoMatch = s.match(/^([a-zA-Z0-9]+):\/\//);
    if (protoMatch) {
        protocol = protoMatch[1].toLowerCase();
        s = s.slice(protoMatch[0].length);
    }

    if (s.includes('@')) {
        const at = s.lastIndexOf('@');
        const userPass = s.slice(0, at);
        const hostPort = s.slice(at + 1);
        if (userPass.includes(':')) {
            const up = userPass.split(':');
            username = decodeURIComponent(up[0]);
            password = decodeURIComponent(up.slice(1).join(':'));
        } else {
            username = decodeURIComponent(userPass);
        }
        s = hostPort;
    }

    const parts = s.split(':');
    if (parts.length === 4) {
        host = parts[0].trim();
        port = parseInt(parts[1], 10) || 8080;
        username = parts[2].trim();
        password = parts[3].trim();
    } else if (parts.length === 2) {
        host = parts[0].trim();
        port = parseInt(parts[1], 10) || 8080;
    } else if (parts.length === 1 && parts[0]) {
        host = parts[0].trim();
    } else {
        return null;
    }

    if (!host) return null;

    const authPart = (username || password)
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
        : '';
    const url = `${protocol}://${authPart}${host}:${port}`;

    return {
        protocol,
        host,
        port,
        username,
        password,
        url
    };
}

// The proxy address with credentials masked for logs and UI display
function maskProxyUrl(url) {
    return String(url || '').replace(/\/\/([^:@/]*):[^@/]*@/, '//$1:••••@');
}

function isLocalOrigin(origin) {
    return /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$|file:\/\/|app:\/\/)/i.test(String(origin));
}

module.exports = {
    parseProxyString,
    maskProxyUrl,
    isLocalOrigin
};
