// Public name alias for the layout primitive. This file used to declare an empty
// subclass (`class Box extends BoxComponent {}`), which added a class body with
// no behaviour of its own. Re-exporting keeps `new Box(...)` and `instanceof Box`
// working identically (it is the same class object) without the dead subclass.
export { BoxComponent as Box } from '../../layout.js';
