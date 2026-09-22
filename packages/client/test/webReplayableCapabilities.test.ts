import assert from "node:assert/strict";
import test from "node:test";
import type { IChannel, IChannelClient } from "@zcode/rpc";
import { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

function recordingClient(requestedChannels: string[]): IChannelClient {
  const channel: IChannel = {
    call: () => Promise.resolve(undefined),
    listen: () => Event.None,
  };
  return {
    getChannel(name: string) {
      requestedChannels.push(name);
      return channel;
    },
  };
}

test("web replayable accessor does not probe the absent window-controller channel", () => {
  const requestedChannels: string[] = [];
  const access = new RemoteServiceAccess(recordingClient(requestedChannels), {
    windowController: false,
  });

  assert.equal(access.windowControllerService, undefined);
  assert.equal(requestedChannels.includes(ServiceChannels.WindowController), false);
});

test("desktop-compatible accessor keeps the window-controller channel by default", () => {
  const requestedChannels: string[] = [];
  const access = new RemoteServiceAccess(recordingClient(requestedChannels));

  assert.notEqual(access.windowControllerService, undefined);
  assert.equal(requestedChannels.includes(ServiceChannels.WindowController), true);
});
