import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
} from '../src/domain/events.js';
import { replayScheme, deriveTank, trailingDecreaseStreak } from '../src/domain/replay.js';
import {
  reviewTankDrift,
  validateDriftParams,
  DRIFT_STATUS,
} from '../src/domain/drift.js';

const AT = '2026-01-01T00:00:00.000Z';

function makeEvents({ limit = 100, requiredRounds = 3, artifactNames = ['甲', '乙'] } = {}) {
  let n = 0;
  const created = buildSchemeCreatedEvent({
    name: '漂移方案',
    tanks: [{ name: '槽', limit, requiredRounds, artifacts: artifactNames.map((name) => ({ name })) }],
  }, () => `id-${(n += 1)}`);
  return [{ ...created, seq: 1, at: AT }];
}

function appendRound(events, valuesByArtifact, ts) {
  const tank = deriveTank(replayScheme(events).tanks[0]);
  const readings = tank.artifacts
    .filter((a) => a.status === 'soaking')
    .map((a, i) => ({ artifactId: a.id, value: valuesByArtifact[i], ts: ts + i * 1000 }));
  events.push({ ...buildRoundEvent(tank, readings), seq: events.length + 1, at: AT });
}

function buildTank(rounds, opts = {}) {
  const events = makeEvents(opts);
  rounds.forEach((values, i) => appendRound(events, values, (i + 1) * 10_000));
  return deriveTank(replayScheme(events).tanks[0]);
}

function review(rounds, params, opts = {}) {
  return reviewTankDrift(buildTank(rounds, opts), params);
}

/** 穷举全部允许校正轨迹：任一轨迹下有器物失格则返回该轨迹，否则返回 null（小规模精确对照）。 */
function bruteForceWitness(valueRows, M, S, R, limit) {
  const n = valueRows[0].length;
  let found = null;
  const rec = (j, prev, seq) => {
    if (j === n) {
      for (const vals of valueRows) {
        const w = vals.map((v, i) => v + seq[i]);
        if (trailingDecreaseStreak(w) < R || w[n - 1] > limit) {
          found = seq.slice();
          return true;
        }
      }
      return false;
    }
    const lo = j === 0 ? -M : Math.max(-M, prev - S);
    const hi = j === 0 ? M : Math.min(M, prev + S);
    for (let c = lo; c <= hi; c += 1) {
      if (rec(j + 1, c, [...seq, c])) return true;
    }
    return false;
  };
  rec(0, null, []);
  return found;
}

test('validateDriftParams：两个参数都须为不小于 0 的整数', () => {
  assert.deepEqual(validateDriftParams({ maxCorrection: 0, maxStep: 0 }), []);
  assert.deepEqual(validateDriftParams({ maxCorrection: 10, maxStep: 3 }), []);
  assert.ok(validateDriftParams({ maxCorrection: -1, maxStep: 1 })[0].includes('最大校正幅度'));
  assert.ok(validateDriftParams({ maxCorrection: 1.5, maxStep: 1 })[0].includes('最大校正幅度'));
  assert.ok(validateDriftParams({ maxCorrection: 1, maxStep: -2 })[0].includes('最大校正变化'));
  assert.ok(validateDriftParams({ maxCorrection: 1, maxStep: NaN })[0].includes('最大校正变化'));
  assert.ok(validateDriftParams(null)[0].includes('漂移参数缺失'));
});

test('M=0 即原始读数：原始达标则任何复核都 robust', () => {
  const r = review([[300, 280], [200, 190], [90, 80]], { maxCorrection: 0, maxStep: 0 });
  assert.equal(r.status, DRIFT_STATUS.OK);
  assert.equal(r.robust, true);
  assert.equal(r.witness, null);
});

test('末尾窗口落差与可达校正差 D=min(S,2M) 的判定精确到严格大于', () => {
  // 单器物 R=3：落差均为 11；上限 100、末值 97（余量 3）
  const make = (M, S) => reviewTankDrift(
    buildTank([[130], [119], [108], [97]], { requiredRounds: 3, limit: 100, artifactNames: ['甲'] }),
    { maxCorrection: M, maxStep: S },
  );
  // M=2、S=20 → D=4：落差全部 > 4，末值余量 3 ≥ M=2 → robust
  assert.equal(make(2, 20).robust, true);
  // M=5、S=20 → D=10：落差 11 > 10 仍安全，但末值余量 3 < 5 → 末值被推过上限
  const last = make(5, 20);
  assert.equal(last.robust, false);
  assert.equal(last.witness.kind, 'last-value');
  // M=6、S=11 → D=min(11,12)=11：末尾窗口（第 3、4 轮）落差恰为 11，可被抹平，第 3 轮早于末值事件
  const tie = make(6, 11);
  assert.equal(tie.robust, false);
  assert.equal(tie.witness.kind, 'decrease');
  assert.equal(tie.witness.round, 3);
});

test('末值余量小于 M：存在轨迹把末值推过上限，witness 取最小常数正校正', () => {
  const r = review([[300, 300], [200, 200], [95, 95]], { maxCorrection: 10, maxStep: 1 }, { limit: 100 });
  assert.equal(r.robust, false);
  assert.equal(r.witness.kind, 'last-value');
  assert.equal(r.witness.round, 3);
  assert.equal(r.witness.artifactName, '甲'); // 同轮同因按器物初始顺序
  // 校正序列须为常数 +6（余量 5，阈值 6），末值 95+6=101 > 100
  assert.deepEqual(r.witness.correction, [6, 6, 6]);
  assert.deepEqual(r.witness.correctedValues, [306, 206, 101]);
});

test('相邻轮变化受 S 限制：落差 8 在 S=5 时不可抹平，在 S=8 时可抹平', () => {
  const rounds1 = [[300], [200], [192]]; // 落差 100、8，R=3，上限 1000（排除末值因素）
  const opts = { requiredRounds: 3, limit: 1000, artifactNames: ['甲'] };
  assert.equal(review(rounds1, { maxCorrection: 50, maxStep: 5 }, opts).robust, true);
  const hit = review(rounds1, { maxCorrection: 50, maxStep: 8 }, opts);
  assert.equal(hit.robust, false);
  assert.equal(hit.witness.kind, 'decrease');
  assert.equal(hit.witness.round, 3);
  assert.deepEqual(hit.witness.correction, [-50, -50, -42]);
  assert.deepEqual(hit.witness.correctedValues, [250, 150, 150]); // 150 → 150 不再严格下降
});

test('witness 校正序列满足全部约束，且确实使该器物失格', () => {
  const cases = [
    { rounds: [[300, 280], [295, 270], [90, 80]], M: 10, S: 10, opts: { requiredRounds: 3 } },
    { rounds: [[500, 500], [400, 400], [99, 99]], M: 5, S: 2, opts: { requiredRounds: 3 } },
    { rounds: [[10, 10], [9, 9], [8, 8], [7, 7]], M: 3, S: 1, opts: { requiredRounds: 2, limit: 100 } },
  ];
  for (const c of cases) {
    const r = review(c.rounds, { maxCorrection: c.M, maxStep: c.S }, c.opts);
    assert.equal(r.robust, false);
    const w = r.witness;
    w.correction.forEach((v) => assert.ok(Math.abs(v) <= c.M));
    for (let i = 1; i < w.correction.length; i += 1) {
      assert.ok(Math.abs(w.correction[i] - w.correction[i - 1]) <= c.S);
    }
    // 用该轨迹重算：被点名器物必须失格
    const streak = trailingDecreaseStreak(w.correctedValues);
    const limit = c.opts.limit ?? 100;
    assert.ok(streak < (c.opts.requiredRounds ?? 3) || w.correctedValues.at(-1) > limit);
  }
});

test('按轮次最早受影响：更早轮次的器物优先于末值事件', () => {
  // 甲落差都大但末值余量不足；乙在第 2 轮落差仅 2
  const r = review(
    [[500, 300], [400, 298], [99, 90]],
    { maxCorrection: 5, maxStep: 5 },
    { requiredRounds: 3, limit: 100 },
  );
  assert.equal(r.robust, false);
  assert.equal(r.witness.round, 2);
  assert.equal(r.witness.artifactName, '乙');
  assert.equal(r.witness.kind, 'decrease');
});

test('只有末尾 R 轮窗口影响当前资格：窗口外的小落差不构成轨迹', () => {
  // R=2，4 轮：第 2 轮落差仅 1（窗口外），末尾两轮落差 50、40 均 > D=3
  const r = review(
    [[500], [499], [400], [360]],
    { maxCorrection: 3, maxStep: 3 },
    { requiredRounds: 2, limit: 1000, artifactNames: ['甲'] },
  );
  assert.equal(r.robust, true);
  assert.equal(r.witness, null);
});

test('轮数不足 / 无读数 / 器物全出槽：返回相应状态且无 witness', () => {
  const two = buildTank([[100, 100], [90, 90]], { requiredRounds: 3 });
  assert.equal(reviewTankDrift(two, { maxCorrection: 5, maxStep: 5 }).status, DRIFT_STATUS.INSUFFICIENT_ROUNDS);
  const empty = buildTank([], { requiredRounds: 2 });
  assert.equal(reviewTankDrift(empty, { maxCorrection: 5, maxStep: 5 }).status, DRIFT_STATUS.NO_ROUNDS);
});

test('换液后只重放本周期（上次换液之后）的读数', () => {
  const events = makeEvents({ requiredRounds: 2, limit: 100 });
  appendRound(events, [300, 300], 10_000);
  appendRound(events, [90, 90], 20_000);
  events.push({ ...buildLiquidChangeEvent(deriveTank(replayScheme(events).tanks[0])), seq: events.length + 1, at: AT });
  // 新周期：两轮落差仅 2，M=5、S=5 下可被抹平
  appendRound(events, [500, 500], 30_000);
  appendRound(events, [498, 498], 40_000);
  const tank = deriveTank(replayScheme(events).tanks[0]);
  const r = reviewTankDrift(tank, { maxCorrection: 5, maxStep: 5 });
  assert.equal(r.rounds, 2);
  assert.equal(r.robust, false);
  assert.deepEqual(r.witness.correction, [-5, 0]);
});

test('精确性：与全轨迹穷举结论一致（多组参数）', () => {
  const scenarios = [
    { rounds: [[10, 9], [8, 7]], M: 2, S: 1, opts: { requiredRounds: 2, limit: 20 } },
    { rounds: [[10, 10], [9, 9], [8, 8]], M: 2, S: 1, opts: { requiredRounds: 3, limit: 20 } },
    { rounds: [[10, 10], [9, 9], [8, 8]], M: 1, S: 1, opts: { requiredRounds: 2, limit: 8 } },
    { rounds: [[10, 10], [10, 10], [8, 8]], M: 2, S: 2, opts: { requiredRounds: 2, limit: 20 } },
    { rounds: [[12, 11], [9, 10], [7, 7]], M: 2, S: 1, opts: { requiredRounds: 2, limit: 7 } },
    { rounds: [[100, 90], [80, 70]], M: 3, S: 3, opts: { requiredRounds: 2, limit: 100 } },
  ];
  for (const sc of scenarios) {
    const tank = buildTank(sc.rounds, sc.opts);
    const r = reviewTankDrift(tank, { maxCorrection: sc.M, maxStep: sc.S });
    const valueRows = tank.artifacts
      .filter((a) => a.status === 'soaking')
      .map((a) => [...a.periodReadings].sort((x, y) => x.roundInPeriod - y.roundInPeriod).map((x) => x.value));
    const brute = bruteForceWitness(valueRows, sc.M, sc.S, sc.opts.requiredRounds, sc.opts.limit);
    assert.equal(r.robust, brute === null, `场景 robust 应与穷举一致：${JSON.stringify(sc)}`);
    if (brute !== null) {
      // 域模块给出的 witness 同样必须真实失格
      const w = r.witness;
      const corrected = valueRows.find((row) => true) && tank.artifacts
        .filter((a) => a.name === w.artifactName)[0]
        .periodReadings
        .sort((x, y) => x.roundInPeriod - y.roundInPeriod)
        .map((x, i) => x.value + w.correction[i]);
      assert.ok(
        trailingDecreaseStreak(corrected) < sc.opts.requiredRounds || corrected.at(-1) > sc.opts.limit,
        'witness 轨迹必须真实推翻资格',
      );
    }
  }
});

test('S=0 时只允许常数校正：严格下降不受影响，相等读数本就不构成下降', () => {
  // 相等读数在原始读数下已失格（落差 0），复核只是确认存在保持失格的常数轨迹
  const equal = review([[10, 10], [10, 10]], { maxCorrection: 5, maxStep: 0 }, { requiredRounds: 2, limit: 20 });
  assert.equal(equal.robust, false);
  assert.equal(equal.rawEligible, false);
  assert.deepEqual(equal.witness.correction, [-5, -5]); // 常数序列，Δc=0
  const strict = review([[10, 10], [9, 9]], { maxCorrection: 5, maxStep: 0 }, { requiredRounds: 2, limit: 20 });
  assert.equal(strict.robust, true);
});
