

export const CLAUDE_AUTO_MODE_GATEWAY_WARNING_MARKERS = [
  "**Warning:** We're changing auto mode to no longer charge for classifier requests in Claude Code.",
  "Warning: We're changing auto mode to no longer charge for classifier requests in Claude Code.",
];

export const CLAUDE_AUTO_MODE_GATEWAY_WARNING_END = "https://code.claude.com/docs/en/auto-mode-classifier-billing";

export class ClaudeCliNoticeFilter {
  private pending = "";
  private captured = "";
  private capturing = false;

  push(chunk: string): { text: string; notice?: string } {
    if (!chunk) return { text: "" };
    if (this.capturing) {
      this.captured += chunk;
      return this.finishNoticeIfComplete("");
    }

    const combined = this.pending + chunk;
    this.pending = "";
    const matches = CLAUDE_AUTO_MODE_GATEWAY_WARNING_MARKERS
      .map((marker) => ({ marker, index: combined.indexOf(marker) }))
      .filter((match) => match.index >= 0)
      .sort((left, right) => left.index - right.index);
    const match = matches[0];
    if (match) {
      const before = combined.slice(0, match.index);
      this.captured = combined.slice(match.index);
      this.capturing = true;
      return this.finishNoticeIfComplete(before);
    }

    let held = 0;
    const maxPrefixLength = Math.min(combined.length, Math.max(...CLAUDE_AUTO_MODE_GATEWAY_WARNING_MARKERS.map((marker) => marker.length - 1)));
    for (let length = maxPrefixLength; length > 0; length--) {
      const suffix = combined.slice(-length);
      if (CLAUDE_AUTO_MODE_GATEWAY_WARNING_MARKERS.some((marker) => marker.startsWith(suffix))) {
        held = length;
        break;
      }
    }
    if (held) {
      this.pending = combined.slice(-held);
      return { text: combined.slice(0, -held) };
    }
    return { text: combined };
  }

  flush(): { text: string } {
    const text = this.pending + this.captured;
    this.reset();
    return { text };
  }

  private finishNoticeIfComplete(prefix: string): { text: string; notice?: string } {
    const end = this.captured.indexOf(CLAUDE_AUTO_MODE_GATEWAY_WARNING_END);
    if (end < 0) return { text: prefix };
    const noticeEnd = end + CLAUDE_AUTO_MODE_GATEWAY_WARNING_END.length;
    const notice = this.captured.slice(0, noticeEnd).trim();
    const trailing = this.captured.slice(noticeEnd);
    this.reset();
    return { text: prefix + trailing, notice };
  }

  private reset(): void {
    this.pending = "";
    this.captured = "";
    this.capturing = false;
  }
}
