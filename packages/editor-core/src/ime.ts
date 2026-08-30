export class ImeProtectionManager {
  private isComposing = false;
  private compositionText = '';

  public onCompositionStart(): void {
    this.isComposing = true;
    this.compositionText = '';
  }

  public onCompositionUpdate(text: string): void {
    if (this.isComposing) {
      this.compositionText = text;
    }
  }

  public onCompositionEnd(finalText: string): string {
    this.isComposing = false;
    this.compositionText = '';
    return finalText;
  }

  public isCompositionActive(): boolean {
    return this.isComposing;
  }

  public getCompositionText(): string {
    return this.compositionText;
  }
}
