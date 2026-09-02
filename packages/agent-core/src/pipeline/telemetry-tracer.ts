import type { TelemetryCollector } from '../telemetry/telemetry.js';
import type { Usage } from '@inkpi/protocol';

/** 阶段 span 句柄。由 `startSpan` 返回类型推导，避免依赖未对外导出的内部类型。 */
export type TelemetrySpanHandle = ReturnType<TelemetryCollector['startSpan']>;

/** 遥测采集器的取值器。用函数而非实例，便于宿主在构造后再替换采集器。 */
export type TelemetrySupplier = () => TelemetryCollector | undefined;

/**
 * 阶段遥测 span 生命周期跟踪器。
 *
 * 把"若已开启遥测则开 span / 收尾时必定关 span"这对散落的执行细节收敛到一处，
 * 使执行器不必反复判空。未开启遥测时全部方法是空操作。
 */
export class TelemetryTracer {
  constructor(private readonly supplier: TelemetrySupplier) {}

  /** 开启一个阶段 span；未开启遥测时返回 `undefined`。 */
  public startStage(stageName: string, stageId: string, roleId: string): TelemetrySpanHandle | undefined {
    return this.supplier()?.startSpan(stageName, stageId, roleId);
  }

  /** 正常收尾。 */
  public endStage(span: TelemetrySpanHandle | undefined, usage?: Usage): void {
    if (!span) return;
    this.supplier()?.endSpan(span.id, usage);
  }

  /** 以失败原因收尾。 */
  public failStage(span: TelemetrySpanHandle | undefined, usage: Usage | undefined, error: string): void {
    if (!span) return;
    this.supplier()?.endSpan(span.id, usage, error);
  }
}
