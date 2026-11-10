import { calendarsResponse, send } from '../lib/handlers.js';

export default async function handler(req, res) {
  send(res, await calendarsResponse());
}
