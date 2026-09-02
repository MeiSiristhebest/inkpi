// Public name alias for the layout primitive. Re-exported instead of declared as
// an empty subclass so `new Spacer(...)` / `instanceof Spacer` keep working
// without a behaviourless class body.
export { SpacerComponent as Spacer } from '../../layout.js';
