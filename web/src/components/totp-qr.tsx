import { useEffect, useState } from "react";
import { toDataURL } from "qrcode";

/** TOTP 开通用二维码：把 otpauth:// URI 渲染为扫码图（qrcode 依赖，不手搓）。 */
export function TotpQr({ uri }: { uri: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setDataUrl(null);
    toDataURL(uri, { width: 180, margin: 1 })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  if (failed) {
    return (
      <div className="flex size-40 items-center justify-center rounded-md border border-paper-300 bg-paper-100 text-center text-xs text-ink-500">
        二维码生成失败，请手动输入下方密钥
      </div>
    );
  }
  if (!dataUrl) {
    return <div className="size-40 animate-pulse rounded-md bg-paper-200" />;
  }
  return (
    <img
      src={dataUrl}
      alt="TOTP 二维码"
      className="size-40 rounded-md border border-paper-300"
    />
  );
}
