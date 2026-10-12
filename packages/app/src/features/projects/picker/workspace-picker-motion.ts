/** Play only for a user opening the picker, never for a restored panel tree. */
export function animateWorkspacePicker(pages: HTMLElement, animatePanel: boolean): Animation[] {
  const picker = pages.querySelector<HTMLElement>(".workspace-tab-picker:not([hidden])");
  if (!picker) return [];
  const animations: Animation[] = [];
  const panel = picker.closest<HTMLElement>(".workspace-side-panel:not(.is-hidden):not(.is-full-view)");
  const easing = "cubic-bezier(.2,.8,.2,1)";
  if (animatePanel && panel) {
    animations.push(panel.animate([
      { opacity: 0, transform: "translateX(16px)" },
      { opacity: 1, transform: "translateX(0)" },
    ], { duration: 220, easing }));
  }
  animations.push(picker.animate([
    { opacity: 0, transform: "translateY(10px) scale(.992)" },
    { opacity: 1, transform: "translateY(0) scale(1)" },
  ], { duration: 250, easing }));
  return animations;
}
