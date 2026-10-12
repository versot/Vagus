import { CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import i18n from "../../../locales/i18n.js";

export function ExtensionNoticeToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  const [closing, setClosing] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const timer = window.setTimeout(() => setClosing(true), 4200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => onDismissRef.current(), 280);
    return () => window.clearTimeout(timer);
  }, [closing]);

  return <div className={`extension-toast${closing ? " is-closing" : ""}`} role="status">
    <CheckCircle2 size={14} />
    <span>{message}</span>
    <button aria-label={i18n.t("关闭扩展通知")} onClick={() => setClosing(true)}><X size={13} /></button>
  </div>;
}
