export class RequestGate {
  private epoch = 0;

  begin(): number {
    this.epoch += 1;
    return this.epoch;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  isCurrent(requestEpoch: number): boolean {
    return requestEpoch === this.epoch;
  }
}
