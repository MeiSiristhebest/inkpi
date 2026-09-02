// Public name alias for the layout primitive. Re-exported instead of declared as
// an empty subclass so `new HStack(...)` / `instanceof HStack` keep working
// without a behaviourless class body.
export { HStackComponent as HStack } from '../../layout.js';
