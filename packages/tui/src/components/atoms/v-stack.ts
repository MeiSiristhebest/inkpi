// Public name alias for the layout primitive. Re-exported instead of declared as
// an empty subclass so `new VStack(...)` / `instanceof VStack` keep working
// without a behaviourless class body.
export { VStackComponent as VStack } from '../../layout.js';
