export function reserveCoverage(balance, dailyBudgetSats, currency) {
    if (!Number.isFinite(balance) || balance < 0) {
        return { state: "unknown", label: "Balance unavailable" };
    }
    if (!Number.isFinite(dailyBudgetSats) || dailyBudgetSats <= 0) {
        return { state: "unknown", label: "Daily payout budget unavailable" };
    }
    const dailyBudget = dailyBudgetSats / 100_000_000;
    const budget = dailyBudget.toLocaleString(undefined, { maximumFractionDigits: 8 });
    return balance >= dailyBudget
        ? { state: "good", label: `Covers a day of payouts · ${budget} ${currency}/day` }
        : { state: "warn", label: `Under a day of payouts · ${budget} ${currency}/day` };
}
