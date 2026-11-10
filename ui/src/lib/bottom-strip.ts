// The detail view's bottom status strip (ReviewInFlightBanner, PulseActionBanner, CiRunningBanner,
// AutoMergeBanner) shows on the two tabs where the operator works with the agent: the terminal
// and the chat. Off them the strips render nothing and publish no height.
export function showsBottomStrip(tab: string): boolean {
  return tab === "term" || tab === "chat";
}
