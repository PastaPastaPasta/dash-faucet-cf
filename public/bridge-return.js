export function bridgeReturnUrl(params, bridgeStart) {
    const bridge = new URL(bridgeStart);
    const raw = params.get('return');
    if (raw) {
        try {
            const url = new URL(raw);
            if (url.origin !== bridge.origin || url.username || url.password || url.pathname !== '/') return null;
            url.searchParams.set('mode', 'resume');
            url.searchParams.set('journey', 'start');
            url.searchParams.set('network', 'testnet');
            const address = params.get('address');
            if (!address) return null;
            url.searchParams.set('deposit', address);
            url.hash = '';
            return url.href;
        } catch { return null; }
    }
    // Existing bookmarked Faucet links also return to one Bridge tab.
    if (params.get('from') === 'bridge' && params.get('address')) {
        bridge.search = new URLSearchParams({mode: 'resume', journey: 'start', network: 'testnet', deposit: params.get('address')});
        return bridge.href;
    }
    return null;
}
