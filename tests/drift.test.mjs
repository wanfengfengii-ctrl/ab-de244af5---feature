import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSchemeCreatedEvent,
  buildRoundEvent,
  buildLiquidChangeEvent,
  buildRemovalEvent,
} from '../src/domain/events.js';
import { replayScheme, deriveTank, trailingDecreaseStreak } from '../src/domain/replay.js';
import { reviewDrift, validateDriftParams } from '../src/domain/drift.js';

const AT = '2026-01-01T00:00:00.000Z';

function makeCreated(requiredRounds = 3) {
  let n = 0;
  const event = buildSchemeCreatedEvent({
    name: '漂移复核方案',
    tanks: [{
      name: '1号槽',
      limit: 100,
      requiredRounds,
      artifacts: [{ name: '甲' }, { name: '乙' }],
    }],
  }, () => `id-${(n += 1)}`);
  return { ...event, seq: 1, at: AT };
}

function append(events, event) {
  events.push({ ...event, seq: events.length + 1, at: AT });
  return events;
}

function derive(events) {
  return deriveTank(replayScheme(events).tanks[0]);
}

/** 依次提交若干轮；valuesOfRound[k] 为该轮 [甲, 乙] 的读数。 */
function schemeWithRounds(valuesOfRound, requiredRounds = 3) {
  const events = [makeCreated(requiredRounds)];
  valuesOfRound.forEach((values, i) => {
    const tank = derive(events);
    const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
    append(events, buildRoundEvent(tank, soaking.map((a, k) => ({
      artifactId: a.id, value: values[k], ts: 1_000 + i * 10_000 + k * 1000,
    }))));
  });
  return events;
}

/** 校验反例校正序列本身合法，且确实使最早受影响器物失去资格。 */
function assertWitnessValid(result, tank) {
  const { maxCorrection, maxDelta } = result.params;
  const { corrections, artifactId, round, kind } = result.witness;
  assert.equal(corrections.length, result.rounds);
  for (const c of corrections) {
    assert.ok(Number.isInteger(c), '校正值须为整数');
    assert.ok(Math.abs(c) <= maxCorrection, '校正值须在幅度内');
  }
  for (let i = 1; i < corrections.length; i += 1) {
    assert.ok(Math.abs(corrections[i] - corrections[i - 1]) <= maxDelta, '相邻轮校正变化须受限');
  }
  const artifact = tank.artifacts.find((a) => a.id === artifactId);
  const values = artifact.periodReadings.map((r, i) => r.value + corrections[i]);
  const streak = trailingDecreaseStreak(values);
  const last = values[values.length - 1];
  assert.ok(
    streak < tank.requiredRounds || last > tank.limit,
    '反例轨迹下受影响器物须失去资格',
  );
  if (kind === 'decrease-broken') {
    assert.ok(values[round - 1] >= values[round - 2], '校正后该轮须未严格下降');
  } else {
    assert.ok(last > tank.limit, '校正后末值须高于上限');
  }
}

test('漂移复核参数校验：须为不小于 0 的整数', () => {
  assert.deepEqual(validateDriftParams({ maxCorrection: 0, maxDelta: 0 }), []);
  assert.deepEqual(validateDriftParams({ maxCorrection: 5, maxDelta: 2 }), []);
  assert.ok(validateDriftParams(null)[0].includes('缺失'));
  assert.ok(validateDriftParams({ maxCorrection: -1, maxDelta: 0 }).some((e) => e.includes('校正幅度')));
  assert.ok(validateDriftParams({ maxCorrection: 1.5, maxDelta: 0 }).some((e) => e.includes('校正幅度')));
  assert.ok(validateDriftParams({ maxCorrection: 1, maxDelta: -2 }).some((e) => e.includes('校正变化')));
  assert.ok(validateDriftParams({ maxCorrection: 1, maxDelta: NaN }).some((e) => e.includes('校正变化')));
  assert.throws(() => reviewDrift(derive([makeCreated()]), { maxCorrection: -1, maxDelta: 0 }), /不合法/);
});

test('本周期尚无读数 / 轮数不足时不提供反例', () => {
  const empty = reviewDrift(derive([makeCreated()]), { maxCorrection: 5, maxDelta: 2 });
  assert.equal(empty.robust, false);
  assert.equal(empty.note, 'no-readings');
  assert.equal(empty.witness, null);

  const short = reviewDrift(derive(schemeWithRounds([[300, 280], [200, 190]])), { maxCorrection: 5, maxDelta: 2 });
  assert.equal(short.robust, false);
  assert.equal(short.note, 'insufficient-rounds');
  assert.equal(short.witness, null);
});

test('全部器物出槽后无需复核', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 80]]);
  for (const a of derive(events).artifacts) {
    append(events, buildRemovalEvent(derive(events), a.id));
  }
  const result = reviewDrift(derive(events), { maxCorrection: 5, maxDelta: 2 });
  assert.equal(result.note, 'no-soaking');
  assert.equal(result.witness, null);
});

test('小幅漂移下资格经得住：全部允许轨迹仍满足连续轮数、严格下降与末值上限', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 92], [80, 88]]);
  const tank = derive(events);
  assert.equal(tank.allSoakingEligible, true);
  const result = reviewDrift(tank, { maxCorrection: 2, maxDelta: 1 });
  assert.equal(result.robust, true);
  assert.equal(result.witness, null);
  assert.equal(result.rounds, 5);
});

test('相邻轮校正变化放宽后资格被推翻：返回最早受影响器物、校正序列与失败原因', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 92], [80, 88]]);
  const tank = derive(events);
  const result = reviewDrift(tank, { maxCorrection: 2, maxDelta: 3 });
  assert.equal(result.robust, false);
  const w = result.witness;
  assert.equal(w.artifactName, '乙'); // 乙第 4 轮原始下降量 3，可被相邻轮变化 3 抹平
  assert.equal(w.round, 4);
  assert.equal(w.kind, 'decrease-broken');
  assert.deepEqual(w.corrections, [-2, -2, -2, 1, -2]);
  assert.deepEqual(w.adjustedValues, [278, 188, 93, 93, 86]);
  assert.ok(w.reason.includes('严格下降'));
  assertWitnessValid(result, tank);
});

test('末值可被抬过上限：常值校正序列推翻资格', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 92], [80, 88]]);
  const tank = derive(events);
  // 下降余量充足（最小下降量 3 > min(1, 30)），但乙末值 88 距上限仅 12
  const result = reviewDrift(tank, { maxCorrection: 15, maxDelta: 1 });
  assert.equal(result.robust, false);
  const w = result.witness;
  assert.equal(w.artifactName, '乙');
  assert.equal(w.round, 5);
  assert.equal(w.kind, 'limit-exceeded');
  assert.deepEqual(w.corrections, [13, 13, 13, 13, 13]);
  assert.equal(w.adjustedValues[4], 101);
  assert.ok(w.reason.includes('上限'));
  assertWitnessValid(result, tank);
});

test('按轮次最早受影响：更早轮次的反例优先于更晚轮次', () => {
  // 甲第 4、5 轮下降量均为 2；乙第 5 轮下降量为 1 —— 最早可推翻的是第 4 轮的甲
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [88, 90], [86, 89]]);
  const result = reviewDrift(derive(events), { maxCorrection: 3, maxDelta: 2 });
  assert.equal(result.robust, false);
  assert.equal(result.witness.round, 4);
  assert.equal(result.witness.artifactName, '甲');
});

test('同一轮次多件器物可被推翻时按槽内顺序取前者', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [89, 94], [80, 88]]);
  const result = reviewDrift(derive(events), { maxCorrection: 3, maxDelta: 2 });
  assert.equal(result.robust, false);
  assert.equal(result.witness.round, 4);
  assert.equal(result.witness.artifactName, '甲');
});

test('校正幅度为 0 时只剩零轨迹：原始读数成立即经得住，不成立即给出零校正反例', () => {
  const good = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 92], [80, 88]]);
  assert.equal(reviewDrift(derive(good), { maxCorrection: 0, maxDelta: 0 }).robust, true);

  // 乙第 4 轮回升（92 → 97），原始读数下已不成立
  const bad = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 97], [80, 88]]);
  const result = reviewDrift(derive(bad), { maxCorrection: 0, maxDelta: 0 });
  assert.equal(result.robust, false);
  assert.equal(result.witness.artifactName, '乙');
  assert.equal(result.witness.round, 4);
  assert.deepEqual(result.witness.corrections, [0, 0, 0, 0, 0]);
});

test('相邻轮变化为 0 时校正须为常值：下降无法被打断，但末值仍可被整体抬升', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 92], [80, 88]]);
  const tank = derive(events);
  // 常值校正不改变相邻轮差值，下降约束全部经得住
  assert.equal(reviewDrift(tank, { maxCorrection: 10, maxDelta: 0 }).robust, true);
  // 常值 +21 使甲末值 80 → 101 越限
  const lifted = reviewDrift(tank, { maxCorrection: 25, maxDelta: 0 });
  assert.equal(lifted.robust, false);
  assert.equal(lifted.witness.kind, 'limit-exceeded');
  assert.equal(lifted.witness.artifactName, '甲');
  assert.deepEqual(lifted.witness.corrections, [21, 21, 21, 21, 21]);
});

test('换液后只复核新周期读数', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 80]]);
  const tank1 = derive(events);
  assert.equal(tank1.allSoakingEligible, true);
  // 旧周期末值贴近上限（80、90，距上限 100 很近），新周期从零重新累计
  append(events, buildLiquidChangeEvent(tank1));
  const tank2 = derive(events);
  assert.equal(tank2.periodRounds.length, 0);
  const result = reviewDrift(tank2, { maxCorrection: 50, maxDelta: 50 });
  assert.equal(result.note, 'no-readings');
});

test('反例为每轮共享一个整数校正，而非分别调整单件读数', () => {
  const events = schemeWithRounds([[300, 280], [200, 190], [90, 95], [85, 92], [80, 88]]);
  const tank = derive(events);
  const result = reviewDrift(tank, { maxCorrection: 2, maxDelta: 3 });
  const { corrections } = result.witness;
  // 同一校正序列同步施加到全部在泡器物：甲在校正后仍达标，乙失去资格
  for (const a of tank.artifacts.filter((x) => x.status === 'soaking')) {
    const adjusted = a.periodReadings.map((r, i) => r.value + corrections[i]);
    const ok = trailingDecreaseStreak(adjusted) >= tank.requiredRounds
      && adjusted[adjusted.length - 1] <= tank.limit;
    assert.equal(ok, a.name === '甲');
  }
});

/** 枚举全部允许校正轨迹（每轮共享整数、幅度与相邻轮变化受限）。 */
function* enumerateTrajectories(n, M, D, prefix = []) {
  if (prefix.length === n) {
    yield prefix;
    return;
  }
  for (let c = -M; c <= M; c += 1) {
    if (prefix.length > 0 && Math.abs(c - prefix[prefix.length - 1]) > D) continue;
    yield* enumerateTrajectories(n, M, D, [...prefix, c]);
  }
}

/** 暴力判定：轨迹下某器物失去资格的最早轮次（无则 null）。 */
function bruteEarliestFailure(values, corrections, R, limit) {
  const n = values.length;
  const adjusted = values.map((v, i) => v + corrections[i]);
  for (let r = n - R + 2; r <= n; r += 1) {
    if (adjusted[r - 1] >= adjusted[r - 2]) return r;
  }
  if (adjusted[n - 1] > limit) return n;
  return null;
}

test('精确判定：与全部允许校正轨迹的暴力枚举结果一致', () => {
  // 确定性伪随机（LCG），覆盖原始读数达标与不达标、边界幅度等情形
  let seed = 20260925;
  const rand = (mod) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % mod;
  };
  let checked = 0;
  for (let caseNo = 0; caseNo < 40; caseNo += 1) {
    const R = 2 + rand(2); // 2..3
    const n = R + rand(2); // R..R+1
    const limit = 50 + rand(51); // 50..100
    const series = [
      Array.from({ length: n }, () => 40 + rand(120)),
      Array.from({ length: n }, () => 40 + rand(120)),
    ];
    const M = rand(4); // 0..3
    const D = rand(4); // 0..3
    const events = schemeWithRounds(
      series[0].map((v, i) => [v, series[1][i]]),
      R,
    );
    const tank = derive(events);
    // 用本用例的上限覆盖方案默认上限
    tank.limit = limit;
    const result = reviewDrift(tank, { maxCorrection: M, maxDelta: D });

    // 暴力枚举：robust 当且仅当所有轨迹下两件器物都保持资格
    let bruteRobust = true;
    let bruteEarliest = null;
    for (const corrections of enumerateTrajectories(n, M, D)) {
      for (const values of series) {
        const failAt = bruteEarliestFailure(values, corrections, R, limit);
        if (failAt != null) {
          bruteRobust = false;
          if (bruteEarliest == null || failAt < bruteEarliest) bruteEarliest = failAt;
        }
      }
    }
    assert.equal(result.robust, bruteRobust, `用例 ${caseNo}：robust 应与暴力枚举一致`);
    if (!bruteRobust) {
      assert.equal(result.witness.round, bruteEarliest, `用例 ${caseNo}：反例轮次应为最早受影响轮次`);
      assertWitnessValid(result, tank);
    } else {
      assert.equal(result.witness, null);
    }
    checked += 1;
  }
  assert.ok(checked > 0);
});
