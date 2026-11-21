const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const P2PKH = { mainnet: { label: 'Mainnet', prefix: 'X', version: 76 }, testnet: { label: 'Testnet', prefix: 'y', version: 140 } };

export async function addressError(address, network) {
    const { label, prefix, version } = P2PKH[network === 'mainnet' ? 'mainnet' : 'testnet'];
    if (!address.startsWith(prefix) || !/^[1-9A-HJ-NP-Za-km-z]{34}$/.test(address)) {
        return `Use a ${label} Core address starting with ${prefix} (34 characters).`;
    }
    let number = 0n;
    for (const char of address) number = number * 58n + BigInt(alphabet.indexOf(char));
    const bytes = new Uint8Array(25);
    for (let i = 24; i >= 0; i--) {
        bytes[i] = Number(number & 255n);
        number >>= 8n;
    }
    if (number !== 0n || bytes[0] !== version) return `Use a ${label} address starting with ${prefix}.`;
    const first = await crypto.subtle.digest('SHA-256', bytes.slice(0, 21));
    const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', first));
    return bytes.slice(21).every((byte, i) => byte === checksum[i])
        ? '' : 'Check the address for a typo. Its checksum does not match.';
}
