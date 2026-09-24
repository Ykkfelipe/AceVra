// Reserved adapter boundary. The first alpha implementation keeps the authority in-process;
// this file prevents callers from depending on filesystem or socket details.
export { createLeaseAuthority } from "./authority.js";
