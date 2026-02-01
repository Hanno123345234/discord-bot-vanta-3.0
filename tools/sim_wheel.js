// Simulation of the professional !wheel logic from index.js
// Run with: node tools\sim_wheel.js

const crypto = require('crypto');

function pickSegment(bet) {
  const segments = [
    { id: 'blank', name: 'Niete', type: 'lose', weightBase: 700, mult: 0 },
    { id: 'small', name: 'Kleiner Gewinn', type: 'win', weightBase: 220, mult: 1 },
    { id: 'medium', name: 'Großer Gewinn', type: 'win', weightBase: 70, mult: 2 },
    { id: 'jackpot', name: 'Jackpot', type: 'jackpot', weightBase: 10, mult: null }
  ];
  const weights = segments.map(s => s.weightBase + (s.type !== 'lose' ? Math.floor((bet - 1) * (s.id === 'small' ? 6 : s.id === 'medium' ? 3 : 1)) : 0));
  const total = weights.reduce((a,b)=>a+b,0);
  const r = crypto.randomInt(0, total);
  let acc = 0;
  for (let i=0;i<segments.length;i++){
    acc += weights[i];
    if (r < acc) return segments[i];
  }
  return segments[segments.length-1];
}

function simulate(bet, users=1000) {
  // users each with 5 spins initially and 100 balance
  const wallets = {};
  for (let i=0;i<users;i++) wallets['u'+i] = { balance: 100, spins: 5 };
  let pool = 0;
  const stats = { totalSpins:0, blank:0, small:0, medium:0, jackpot:0, totalPayout:0 };

  // each user uses all spins sequentially
  for (let uid=0; uid<users; uid++){
    const user = wallets['u'+uid];
    while (user.spins > 0) {
      if (user.balance < bet) break; // can't bet
      // debit
      user.balance -= bet;
      pool += bet;
      user.spins -= 1;
      stats.totalSpins++;

      const seg = pickSegment(bet);
      if (seg.type === 'win') {
        let payout = Math.floor(bet * seg.mult);
        const payFromPool = Math.min(pool, payout);
        payout = payFromPool;
        pool -= payout;
        user.balance += payout;
        stats.totalPayout += payout;
        stats[seg.id]++;
      } else if (seg.type === 'jackpot') {
        const playerBetShare = bet;
        const available = Math.max(0, pool - playerBetShare);
        const payout = available;
        pool -= payout;
        user.balance += payout;
        stats.totalPayout += payout;
        stats.jackpot++;
      } else {
        stats.blank++;
      }
    }
  }

  return { bet, users, stats, pool, wallets };
}

function runAll(){
  console.log('Simulating wheel — per-bet runs (users=1000, up to 5 spins each)');
  for (let bet=1; bet<=5; bet++){
    const res = simulate(bet, 1000);
    const s = res.stats;
    console.log(`\nBet ${bet}€ — Spins: ${s.totalSpins}`);
    console.log(`Blanks: ${s.blank} (${(s.blank/s.totalSpins*100).toFixed(2)}%)`);
    console.log(`Small: ${s.small}, Medium: ${s.medium}, Jackpot: ${s.jackpot}`);
    console.log(`Total payout: ${s.totalPayout}€ — Final pool: ${res.pool}€`);
    console.log(`Avg payout per spin: ${(s.totalPayout/s.totalSpins).toFixed(4)}€`);
  }
}

runAll();
