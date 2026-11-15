/**
 * Cross-environment clipboard copy utility.
 * Supports Modern Async Clipboard API (Secure Context: HTTPS/localhost)
 * with robust execCommand('copy') fallback for non-secure contexts (LAN HTTP, IP addresses).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof text !== "string") {
    text = String(text ?? "");
  }

  // 1. Try modern navigator.clipboard API if available (HTTPS or localhost)
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      // SecurityError or NotAllowedError in non-secure context or permission denied
      console.warn("navigator.clipboard.writeText failed, falling back to execCommand:", err);
    }
  }

  // 2. Fallback using temporary textarea and document.execCommand('copy')
  if (typeof document !== "undefined") {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;

      // Position element off-screen without causing scroll jumps
      textArea.style.position = "fixed";
      textArea.style.top = "-9999px";
      textArea.style.left = "-9999px";
      textArea.style.width = "2em";
      textArea.style.height = "2em";
      textArea.style.padding = "0";
      textArea.style.border = "none";
      textArea.style.outline = "none";
      textArea.style.boxShadow = "none";
      textArea.style.background = "transparent";
      textArea.style.opacity = "0";

      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      textArea.setSelectionRange(0, text.length);

      const successful = document.execCommand("copy");
      document.body.removeChild(textArea);
      return successful;
    } catch (err) {
      console.error("Fallback clipboard copy failed:", err);
      return false;
    }
  }

  return false;
}
