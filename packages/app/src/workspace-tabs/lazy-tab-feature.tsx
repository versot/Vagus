import { useEffect, useState, type ComponentType } from "react";
import i18n from "../locales/i18n.js";

type FeatureProps = { visible: boolean };

/** Loads a tab's heavy implementation on first activation and exposes a retry
 * when the chunk cannot be fetched. The wrapper itself stays lightweight. */
export function LazyTabFeature<P extends FeatureProps>({ load, props }: {
  load: () => Promise<{ default: ComponentType<P> }>;
  props: P;
}) {
  const [Feature, setFeature] = useState<ComponentType<P> | null>(null);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!props.visible || Feature) return;
    let active = true;
    setFailure("");
    void load().then(module => {
      if (active) setFeature(() => module.default);
    }).catch(reason => {
      if (active) setFailure(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [Feature, attempt, load, props.visible]);

  if (Feature) return <Feature {...props} />;
  if (!props.visible) return null;
  if (failure) return <div className="workspace-tab-load-state" role="alert"><span>{i18n.t("无法加载此标签")}：{failure}</span><button type="button" onClick={() => { setFailure(""); setAttempt(value => value + 1); }}>{i18n.t("重试")}</button></div>;
  return <div className="workspace-tab-load-state" role="status" aria-live="polite">{i18n.t("正在加载…")}</div>;
}
