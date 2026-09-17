(function () {
    const script = document.currentScript || document.querySelector('script[data-key]');
    const apiKey = script?.getAttribute('data-key');
    if (!apiKey) return;

    const scriptSrc = script?.src || '';
    const base = scriptSrc ? scriptSrc.replace(/\/widget\.js.*$/, '') : '';

    const container = document.getElementById('monasite-widget');
    if (!container) return;

    fetch(`${base}/api/widget/${apiKey}`)
        .then(r => r.json())
        .then(b => {
            if (b.error) return;
            const stars = Math.round(b.avg_rating || 0);
            const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);
            const isVerified = !!b.verified_at;
            container.innerHTML = `
                <div style="display:inline-flex;align-items:center;gap:10px;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:10px 14px;font-family:'Inter',system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,0.06)">
                    <div style="display:flex;flex-direction:column;align-items:center;line-height:1">
                        <span style="color:#C9A84C;font-size:1rem;letter-spacing:1px">${starStr}</span>
                        <span style="font-size:0.65rem;color:#8B857C;margin-top:2px">${b.review_count || 0} review${b.review_count !== 1 ? 's' : ''}</span>
                    </div>
                    <div style="width:1px;height:32px;background:#e5e7eb"></div>
                    <div>
                        <div style="font-size:0.78rem;font-weight:700;color:#2A2823;margin-bottom:2px">${escHtml(b.name)}</div>
                        ${isVerified ? `<div style="font-size:0.62rem;color:#059669;font-weight:600">✓ Verified on Monasite</div>` : ''}
                    </div>
                    <div style="width:1px;height:32px;background:#e5e7eb"></div>
                    <a href="${escHtml(b.profile_url)}" target="_blank" rel="noopener"
                       style="font-size:0.72rem;font-weight:600;color:#2A2823;text-decoration:none;white-space:nowrap;background:#f3f4f6;padding:6px 10px;border-radius:6px;border:1px solid #e5e7eb">
                        Leave a Review →
                    </a>
                </div>`;
        })
        .catch(() => {});

    function escHtml(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
})();
