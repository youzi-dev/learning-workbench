import { createEgressProxy } from "../server/capture/egress";
createEgressProxy().listen(3128, "0.0.0.0");
