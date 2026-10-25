// Spike: a donn-style route-auth policy. The token is read per request, so `eve build`
// (which evaluates this module without the run-time env) never sees or needs it.
import { eveChannel } from "eve/channels/eve";
import {
  extractBearerToken,
  localDev,
  withAuthChallenges,
  type AuthFn,
} from "eve/channels/auth";

const donnToken: AuthFn<Request> = withAuthChallenges(
  (request) => {
    const expected = process.env.DONN_ROUTE_TOKEN;
    const token = extractBearerToken(request.headers.get("authorization"));
    if (!expected || !token || token !== expected) return null;
    return {
      attributes: {},
      authenticator: "donn",
      principalId: "donn-local",
      principalType: "service",
    };
  },
  [{ scheme: "Bearer" }],
);

export default eveChannel({ auth: [donnToken, localDev()] });
