const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export async function addressError(address, network) {
    const label = network === 'mainnet' ? 'Mainnet' : 'Testnet';
    const prefix = network === 'mainnet' ? /^[X7]/ : /^[y8]/;
    if (!prefix.test(address) || !/^[1-9A-HJ-NP-Za-km-z]{34}$/.test(address)) {
        return `Use a ${label} Core address starting with ${network === 'mainnet' ? 'X or 7' : 'y or 8'} (34 characters).`;
    }
    let number = 0n;
    for (const char of address) number = number * 58n + BigInt(alphabet.indexOf(char));
    const bytes = new Uint8Array(25);
    for (let i = 24; i >= 0; i--) {
        bytes[i] = Number(number & 255n);
        number >>= 8n;
    }
    const versions = network === 'mainnet' ? [76, 16] : [140, 19];
    if (number !== 0n || !versions.includes(bytes[0])) return `Use an address from ${label}.`;
    const first = await crypto.subtle.digest('SHA-256', bytes.slice(0, 21));
    const checksum = new Uint8Array(await crypto.subtle.digest('SHA-256', first));
    return bytes.slice(21).every((byte, i) => byte === checksum[i])
        ? '' : 'Check the address for a typo. Its checksum does not match.';
}
