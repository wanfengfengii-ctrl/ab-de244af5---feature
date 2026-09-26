/**
 * 漂移复核（纯领域逻辑，不依赖浏览器，可在 Node 中直接测试）。
 *
 * 修复师在依据当前槽位资格换液或出槽前，可填入电导仪漂移参数复核结论是否可靠：
 * - maxCorrection（M）：本周期每轮读数共用的最大整数校正幅度；
 * - maxStep（S）：相邻两轮之间允许的最大校正变化。
 *
 * 模型：自上次换液以来，为每一轮联合选择一个共享整数校正值 c_j
 * （同一轮全部在泡器物共用，不分别调整单件读数），满足
 *   |c_j| ≤ M 且 |c_j - c_{j-1}| ≤ S；
 * 器物 a 第 j 轮校正后读数为 w[a][j] = v[a][j] + c_j。
 *
 * 既有资格要求仍须在「所有允许校正轨迹」下成立：末尾连续 R 轮逐轮严格下降，
 * 且末值不高于上限。只要存在一条轨迹使任一件在泡器物失去资格，结论即仅在
 * 原始读数下暂时成立；此时给出按轮次最早受影响的器物、完整校正序列与失败原因。
 *
 * 精确性：c_1 除 |c_1| ≤ M 外无其他约束，可行域为整数区间差约束构成的凸集，
 * 任一位置都可取值 [-M, M]，且任一可行前缀总能以常数序列延伸至末轮，故每个
 * 单点失败事件可独立判定可达性：
 * - 第 j 轮落差 g = v[j-1] - v[j] 被抹平（w[j] ≥ w[j-1]）当且仅当 g ≤ D，
 *   其中 D = min(S, 2M) 是相邻轮校正差的可达上界；
 * - 末值被推过上限当且仅当 M ≥ limit - v[n] + 1（即 M > 末值余量）。
 */

export const DRIFT_STATUS = Object.freeze({
  OK: 'ok',
  EMPTY: 'empty',
  NO_ROUNDS: 'no-rounds',
  INSUFFICIENT_ROUNDS: 'insufficient-rounds',
});

/** 校验漂移参数；返回错误信息数组，空数组表示通过。 */
export function validateDriftParams(params) {
  const errors = [];
  if (!params || typeof params !== 'object') return ['漂移参数缺失'];
  if (!Number.isInteger(params.maxCorrection) || params.maxCorrection < 0) {
    errors.push('每轮最大校正幅度须为不小于 0 的整数（µS/cm）');
  }
  if (!Number.isInteger(params.maxStep) || params.maxStep < 0) {
    errors.push('相邻轮最大校正变化须为不小于 0 的整数（µS/cm）');
  }
  return errors;
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
}

/**
 * 对 deriveTank 派生的槽状态做漂移复核。
 * @returns {object} 复核结论；status 非 ok 时 robust 恒为 false、witness 恒为 null。
 */
export function reviewTankDrift(tank, params) {
  const errors = validateDriftParams(params);
  if (errors.length > 0) throw new Error(errors.join('；'));

  const M = params.maxCorrection;
  const S = params.maxStep;
  const R = tank.requiredRounds;
  const n = tank.periodRounds.length;
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  // 原始读数（零校正）下当前资格是否成立，用于区分“经不住漂移”与“原始读数本就不达标”。
  const rawEligible = soaking.length > 0 && soaking.every((a) => a.eligible);

  const base = {
    status: DRIFT_STATUS.OK,
    params: { maxCorrection: M, maxStep: S },
    rounds: n,
    requiredRounds: R,
    limit: tank.limit,
    deltaBound: Math.min(S, 2 * M),
    rawEligible,
    robust: false,
    artifacts: [],
    witness: null,
  };

  if (soaking.length === 0) return { ...base, status: DRIFT_STATUS.EMPTY };
  if (n === 0) return { ...base, status: DRIFT_STATUS.NO_ROUNDS };
  if (n < R) return { ...base, status: DRIFT_STATUS.INSUFFICIENT_ROUNDS };

  // 相邻轮校正差的可达上界：受相邻轮变化 S 与幅度跨度 2M 双重限制。
  const D = Math.min(S, 2 * M);

  // 每件在泡器物在本周期每一轮都有读数（提交校验保证），按轮次对齐取值。
  const rows = soaking.map((artifact) => {
    const sorted = [...artifact.periodReadings].sort((a, b) => a.roundInPeriod - b.roundInPeriod);
    return {
      artifact,
      artifactIndex: tank.artifacts.indexOf(artifact),
      values: sorted.map((r) => r.value),
    };
  });

  // 收集所有可被某条允许轨迹触发的失败事件，随后按“最早轮次”择优出证。
  const events = [];
  const artifactResults = rows.map(({ artifact, values }) => {
    const lastValue = values[n - 1];
    const lastMargin = tank.limit - lastValue;
    const lastValueRobust = M <= lastMargin;
    if (!lastValueRobust) {
      events.push({
        round: n,
        kind: 'last-value',
        kindRank: 1,
        artifactIndex: tank.artifacts.indexOf(artifact),
        artifact,
        lastValue,
        lastMargin,
        threshold: lastMargin + 1,
      });
    }
    // 仅末尾 R 轮（R-1 个相邻落差）影响“连续达标轮数”，更早的落差与当前资格无关。
    let minGap = null;
    for (let j = Math.max(2, n - R + 2); j <= n; j += 1) {
      const gap = values[j - 2] - values[j - 1];
      minGap = minGap == null ? gap : Math.min(minGap, gap);
      if (gap <= D) {
        events.push({
          round: j,
          kind: 'decrease',
          kindRank: 0,
          artifactIndex: tank.artifacts.indexOf(artifact),
          artifact,
          gap,
        });
      }
    }
    const decreaseRobust = minGap != null && minGap > D;
    return {
      id: artifact.id,
      name: artifact.name,
      robust: lastValueRobust && decreaseRobust,
      lastValue,
      lastMargin,
      minGap,
    };
  });

  if (events.length === 0) {
    return { ...base, status: DRIFT_STATUS.OK, robust: true, artifacts: artifactResults };
  }

  // 按轮次最早受影响；同轮先取“未严格下降”，再按器物在槽内的初始顺序。
  events.sort((a, b) =>
    (a.round - b.round)
    || (a.kindRank - b.kindRank)
    || (a.artifactIndex - b.artifactIndex));
  const hit = events[0];
  const correction = buildWitnessCorrection(n, hit, M, D);
  const hitValues = rows.find((r) => r.artifact.id === hit.artifact.id).values;
  const correctedValues = hitValues.map((v, i) => v + correction[i]);

  let reason;
  let detail;
  if (hit.kind === 'decrease') {
    const j = hit.round;
    const from = correctedValues[j - 2];
    const to = correctedValues[j - 1];
    reason = `第 ${j} 轮校正后读数 ${from} → ${to}，未严格下降`;
    detail = `原始落差仅 ${hit.gap}，不大于相邻轮校正差可达上界 ${D}（|Δc| ≤ S=${S} 且 ≤ 2M=${2 * M}），该校正轨迹把第 ${j} 轮的严格下降抹平。`;
  } else {
    reason = `末轮校正后末值 ${correctedValues[n - 1]} 高于上限 ${tank.limit}`;
    detail = `末值余量仅 ${hit.lastMargin}，小于每轮最大校正幅度 ${M}：末轮校正取 ${signed(correction[n - 1])} 即可把末值 ${hit.lastValue} 推过上限。`;
  }

  return {
    ...base,
    status: DRIFT_STATUS.OK,
    robust: false,
    artifacts: artifactResults,
    witness: {
      round: hit.round,
      kind: hit.kind,
      artifactId: hit.artifact.id,
      artifactName: hit.artifact.name,
      reason,
      detail,
      correction,
      correctedValues,
    },
  };
}

/**
 * 构造一条确实触发命中事件的完整整数校正轨迹：
 * - 落差被抹平：第 round 轮前取 -M、自该轮起取 -M+D，相邻差恰为 D（≥ 被抹平落差 g）；
 * - 末值超上限：全程取触发所需的最小常数校正，相邻差为 0。
 * 两条序列均满足 |c_j| ≤ M 与相邻轮变化约束。
 */
function buildWitnessCorrection(n, hit, M, D) {
  const c = new Array(n).fill(0);
  if (hit.kind === 'last-value') {
    const value = Math.max(-M, Math.min(M, hit.threshold));
    c.fill(value);
    return c;
  }
  const low = -M;
  const high = -M + D;
  for (let i = 0; i < hit.round - 1; i += 1) c[i] = low;
  for (let i = hit.round - 1; i < n; i += 1) c[i] = high;
  return c;
}
