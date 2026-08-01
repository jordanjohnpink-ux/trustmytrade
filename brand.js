(function () {
    var SITE = window.SITE || {};
    var n = SITE.name || '';
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    // Favicon — set <link rel="icon"> so the browser picks up the uploaded file
    if (SITE.favicon) {
        var link = document.querySelector("link[rel~='icon']");
        if (!link) { link = document.createElement('link'); link.rel = 'shortcut icon'; document.head.appendChild(link); }
        link.href = '/favicon.ico';
    }

    if (!n) return;

    // Navbar brand — replace with logo image when one is uploaded, else use site name text
    document.querySelectorAll('.nav-brand').forEach(function (el) {
        if (SITE.logo) {
            el.innerHTML = '<img src="' + esc(SITE.logo) + '" alt="' + esc(n) + '" style="height:38px;max-width:180px;object-fit:contain;display:block">';
        } else {
            el.textContent = n;
        }
    });

    // Footer brand — always text (logo may not be legible on dark background)
    document.querySelectorAll('.footer-brand').forEach(function (el) {
        el.textContent = n;
    });

    // Admin sidebar brand — preserve the "Admin Panel" subtext
    var sb = document.querySelector('.admin-sidebar-brand');
    if (sb) {
        sb.innerHTML = esc(n) + '<span style="font-size:0.65rem;font-family:\'Inter\',sans-serif;color:rgba(255,255,255,0.35);display:block;margin-top:0.2rem;font-weight:400">Admin Panel</span>';
    }

    // Any element with data-brand — set to site name text
    document.querySelectorAll('[data-brand]').forEach(function (el) {
        el.textContent = n;
    });

    // Page title
    document.title = document.title.replace(/Monasite/gi, n);
})();
