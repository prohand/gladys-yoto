// -----------------------------------------------------------------------------
// The connection badge of the Configuration screen.
//
// Every failure turns it red, so every success has to be able to turn it green
// again: before this, only "Test the connection" and the start-up read did, and
// a single transient error (Yoto down for a minute, a network hiccup) left the
// badge red for good while the polls were working again.
//
// The last state sent is remembered so a poll every minute does not resend
// "connected" to Gladys each time — only a change goes out.
// -----------------------------------------------------------------------------

export class ConnectionStatus {
  /** @param {{ setConnectionStatus: Function }} gladys */
  constructor(gladys) {
    this.gladys = gladys;
    /** @type {boolean|undefined} last state Gladys accepted (undefined: unknown) */
    this.state = undefined;
  }

  /**
   * Report the Yoto cloud as reachable — a no-op when it already is. A failed
   * report is not remembered, so the next success tries again.
   */
  async connected() {
    if (this.state === true) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(true);
      this.state = true;
    } catch {
      this.state = undefined;
    }
  }

  /** Report a problem with its bilingual message. Always sent: the message may differ. */
  async disconnected(message) {
    this.state = false;
    try {
      await this.gladys.setConnectionStatus(false, message);
    } catch {
      // Gladys unreachable: nothing else to report it to.
      this.state = undefined;
    }
  }

  /** Forget the last state (a new connection to Gladys): the next report goes out. */
  reset() {
    this.state = undefined;
  }
}
