/**
 * 漂移复核：电导仪缓慢漂移时，当前槽位资格结论是否仍然可靠。
 *
 * 模型：为本周期每一轮联合选择一个共享整数校正值 c_r（而非分别调整单件读数），
 * 满足 |c_r| ≤ maxCorrection，且相邻轮 |c_r - c_{r-1}| ≤ maxDelta；
 * 第 r 轮全部在泡器物的读数按 v + c_r 同步校正。
 *
 * 精确判定：资格只取决于本周期末 requiredRounds 轮 ——
 * 第 n-R+2..n 轮的严格下降约束与第 n 轮的末值上限约束。
 * 某条下降约束（第 r 轮）可被推翻，当且仅当原始下降量 gap ≤ min(maxDelta, 2·maxCorrection)
 * （相邻轮校正差最大只能达到该值）；末值上限可被推翻，当且仅当
 * 使末值越限所需的最小校正 limit - v_n + 1 ≤ maxCorrection。
 * 单个约束被推翻即构成反例，且每个约束都可独立实现（其余轮取常值校正），
 * 因此按轮次自早到晚扫描即得精确结论与最早受影响的器物。
 *
 * 本模块不依赖浏览器，可在 Node 中直接测试。
 */

/** 校验漂移复核参数：均须为不小于 0 的整数。 */
export function validateDriftParams(params) {
  const errors = [];
  if (!params || typeof params !== 'object') {
    return ['复核参数缺失'];
  }
  if (!Number.isInteger(params.maxCorrection) || params.maxCorrection < 0) {
    errors.push('最大整数校正幅度须为不小于 0 的整数');
  }
  if (!Number.isInteger(params.maxDelta) || params.maxDelta < 0) {
    errors.push('相邻轮允许的最大校正变化须为不小于 0 的整数');
  }
  return errors;
}

/**
 * 复核指定槽位当前周期资格在允许漂移下是否仍然成立。
 *
 * @param {object} tank 由 deriveTank 派生的槽状态
 * @param {{maxCorrection:number, maxDelta:number}} params
 * @returns 复核结果；robust 为 false 且存在反例时，witness 携带
 *          按轮次最早受影响的器物、校正序列（每轮一个共享整数）与失败原因。
 */
export function reviewDrift(tank, params) {
  const errors = validateDriftParams(params);
  if (errors.length > 0) throw new Error(`漂移复核参数不合法：${errors.join('；')}`);
  const M = params.maxCorrection;
  const D = params.maxDelta;
  const soaking = tank.artifacts.filter((a) => a.status === 'soaking');
  const n = tank.periodRounds.length;
  const R = tank.requiredRounds;
  const base = {
    tankId: tank.id,
    period: tank.liquidChanges,
    rounds: n,
    requiredRounds: R,
    limit: tank.limit,
    params: { maxCorrection: M, maxDelta: D },
  };
  if (soaking.length === 0) return { ...base, robust: false, note: 'no-soaking', witness: null };
  if (n === 0) return { ...base, robust: false, note: 'no-readings', witness: null };

  // 在泡器物自上次换液后每轮各有一次读数（出槽不可逆，在泡即全程在泡）。
  const series = soaking.map((a) => {
    const readings = [...a.periodReadings].sort((x, y) => x.roundInPeriod - y.roundInPeriod);
    if (readings.length !== n) throw new Error(`器物「${a.name}」本周期读数与轮次不一致`);
    return { artifact: a, values: readings.map((r) => r.value) };
  });

  // 轮数不足所需连续轮数：任何校正轨迹下资格都不成立，与漂移无关。
  if (n < R) return { ...base, robust: false, note: 'insufficient-rounds', witness: null };

  const windowStart = n - R + 1; // 窗口起始轮（1 起）：资格只取决于第 windowStart..n 轮
  const maxStep = Math.min(D, 2 * M); // 相邻轮校正差可达的上界
  let found = null;
  // 按轮次自早到晚，找第一个可被推翻的严格下降约束（同轮按槽内器物顺序）。
  for (let r = windowStart + 1; r <= n && !found; r += 1) {
    for (const { artifact, values } of series) {
      const gap = values[r - 2] - values[r - 1]; // 原始下降量；≤0 表示原始读数已未下降
      if (gap <= maxStep) {
        found = { kind: 'decrease-broken', round: r, artifact, values, gap };
        break;
      }
    }
  }
  // 下降约束全部经得住，再检查末值上限（第 n 轮）。
  if (!found) {
    for (const { artifact, values } of series) {
      const need = tank.limit - values[n - 1] + 1; // 使末值越限所需的最小校正
      if (need <= M) {
        found = { kind: 'limit-exceeded', round: n, artifact, values, need };
        break;
      }
    }
  }
  if (!found) return { ...base, robust: true, note: null, witness: null };

  const corrections = witnessCorrections(found, n);
  const adjustedValues = found.values.map((v, i) => v + corrections[i]);
  const reason = found.kind === 'decrease-broken'
    ? `严格下降被打断：校正后第 ${found.round - 1} 轮 ${adjustedValues[found.round - 2]}`
      + ` → 第 ${found.round} 轮 ${adjustedValues[found.round - 1]}，未严格下降`
    : `末值高于上限：校正后末值 ${adjustedValues[n - 1]} 高于上限 ${tank.limit}`;
  return {
    ...base,
    robust: false,
    note: null,
    witness: {
      artifactId: found.artifact.id,
      artifactName: found.artifact.name,
      round: found.round,
      kind: found.kind,
      corrections,
      adjustedValues,
      reason,
    },
  };
}

/** 构造反例校正序列：每轮一个共享整数，满足幅度与相邻轮变化约束。 */
function witnessCorrections(found, n) {
  const corrections = new Array(n);
  if (found.kind === 'limit-exceeded') {
    // 常值校正：各轮相同，相邻轮变化为 0，必然满足约束。
    corrections.fill(Math.max(found.need, 0));
    return corrections;
  }
  // 在目标轮制造恰好足够的校正差，其余轮保持同一常值。
  const target = Math.max(found.gap, 0);
  const lo = target === 0 ? 0 : -Math.ceil(target / 2); // 避免产生 -0
  const hi = Math.floor(target / 2);
  for (let r = 1; r <= n; r += 1) corrections[r - 1] = r === found.round ? hi : lo;
  return corrections;
}
