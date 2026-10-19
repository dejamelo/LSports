import { useEffect, useState, type CSSProperties } from "react";
export type Presentation = "web" | "mobile" | "pos";
export function usePresentation(channel: Presentation) {
  const [format, setFormat] = useState<Presentation>(channel),
    [viewport, setViewport] = useState({
      width: innerWidth,
      height: innerHeight,
      top: 0,
      inset: 0,
    });
  useEffect(() => {
    const update = () => {
      const v = window.visualViewport;
      setViewport({
        width: innerWidth,
        height: v?.height ?? innerHeight,
        top: v?.offsetTop ?? 0,
        inset: Math.max(
          0,
          innerHeight - (v?.height ?? innerHeight) - (v?.offsetTop ?? 0),
        ),
      });
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, []);
  useEffect(() => {
    if (parent === window) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== location.origin) return;
      const data = event.data;
      if (
        data?.type === "adl.preview.presentation" &&
        ["web", "mobile", "pos"].includes(data.format)
      )
        setFormat(data.format);
    };
    window.addEventListener("message", receive);
    parent.postMessage({ type: "adl.preview.ready" }, location.origin);
    return () => window.removeEventListener("message", receive);
  }, []);
  return {
    format,
    compact: format !== "web" || viewport.width <= 900,
    style: {
      "--visual-height": `${viewport.height}px`,
      "--visual-top": `${viewport.top}px`,
      "--keyboard-inset": `${viewport.inset}px`,
    } as CSSProperties,
  };
}
