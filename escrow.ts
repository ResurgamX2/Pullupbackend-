import { Router } from "express";

const router = Router();

// ─── In-memory escrow store (swap for DB in production) ───────────────────────
// In production: replace with Drizzle ORM queries + Stripe PaymentIntent calls.

type EscrowStatus = "held" | "released" | "refunded" | "disputed";

interface EscrowRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  requesterId: string;
  requesterName: string;
  helperId?: string;
  helperName?: string;
  amount: number;
  platformFee: number;
  helperPayout: number;
  status: EscrowStatus;
  createdAt: string;
  acceptedAt?: string;
  releasedAt?: string;
  disputedAt?: string;
  disputeReason?: string;
  autoReleaseAt?: string;
  stripePaymentIntentId?: string;
}

const escrowStore = new Map<string, EscrowRecord>();

const PLATFORM_FEE_RATE = 0.15;
const AUTO_RELEASE_HOURS = 2;

function genId() {
  return "esc_" + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function calcFees(amount: number) {
  const platformFee = Math.round(amount * PLATFORM_FEE_RATE * 100) / 100;
  const helperPayout = Math.round((amount - platformFee) * 100) / 100;
  return { platformFee, helperPayout };
}

// ─── POST /api/escrow/create ──────────────────────────────────────────────────
// Creates an escrow hold when a task is posted.
// In production: call Stripe PaymentIntents.create({ amount, currency, capture_method: 'manual' })
// and store the paymentIntentId.
router.post("/create", (req, res) => {
  const { taskId, taskTitle, requesterId, requesterName, amount } = req.body as {
    taskId: string;
    taskTitle: string;
    requesterId: string;
    requesterName: string;
    amount: number;
  };

  if (!taskId || !requesterId || !amount || amount <= 0) {
    res.status(400).json({ error: "taskId, requesterId, and amount are required" });
    return;
  }

  const { platformFee, helperPayout } = calcFees(amount);

  const record: EscrowRecord = {
    id: genId(),
    taskId,
    taskTitle: taskTitle ?? "",
    requesterId,
    requesterName: requesterName ?? "",
    amount,
    platformFee,
    helperPayout,
    status: "held",
    createdAt: new Date().toISOString(),
    // stripePaymentIntentId: stripeIntent.id  ← add when Stripe keys are configured
  };

  escrowStore.set(taskId, record);
  req.log.info({ escrowId: record.id, amount }, "Escrow created");
  res.status(201).json(record);
});

// ─── PATCH /api/escrow/:taskId/link-helper ────────────────────────────────────
// Links a helper to the escrow after they accept.
router.patch("/:taskId/link-helper", (req, res) => {
  const { taskId } = req.params;
  const { helperId, helperName } = req.body as { helperId: string; helperName: string };

  const record = escrowStore.get(taskId);
  if (!record) { res.status(404).json({ error: "Escrow not found" }); return; }
  if (record.status !== "held") { res.status(409).json({ error: `Escrow status is ${record.status}` }); return; }

  record.helperId = helperId;
  record.helperName = helperName;
  record.acceptedAt = new Date().toISOString();
  record.autoReleaseAt = new Date(
    Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000
  ).toISOString();

  req.log.info({ taskId, helperId }, "Helper linked to escrow");
  res.json(record);
});

// ─── POST /api/escrow/:taskId/release ────────────────────────────────────────
// Requester confirms task completion; funds released to helper.
// In production: call Stripe PaymentIntents.capture() then Transfers.create() to helper's connected account.
router.post("/:taskId/release", (req, res) => {
  const { taskId } = req.params;
  const { requesterId } = req.body as { requesterId: string };

  const record = escrowStore.get(taskId);
  if (!record) { res.status(404).json({ error: "Escrow not found" }); return; }
  if (record.requesterId !== requesterId) { res.status(403).json({ error: "Only requester can release" }); return; }
  if (record.status !== "held") { res.status(409).json({ error: `Cannot release escrow in ${record.status} state` }); return; }
  if (!record.helperId) { res.status(409).json({ error: "No helper linked yet" }); return; }

  // Prevent double-payout
  record.status = "released";
  record.releasedAt = new Date().toISOString();

  req.log.info({ taskId, helperPayout: record.helperPayout }, "Escrow released to helper");
  res.json(record);
});

// ─── POST /api/escrow/:taskId/refund ─────────────────────────────────────────
// Admin or system refunds requester (e.g., no helper found).
router.post("/:taskId/refund", (req, res) => {
  const { taskId } = req.params;
  const record = escrowStore.get(taskId);
  if (!record) { res.status(404).json({ error: "Escrow not found" }); return; }
  if (record.status !== "held" && record.status !== "disputed") {
    res.status(409).json({ error: `Cannot refund escrow in ${record.status} state` }); return;
  }
  record.status = "refunded";
  record.releasedAt = new Date().toISOString();
  req.log.info({ taskId }, "Escrow refunded to requester");
  res.json(record);
});

// ─── POST /api/escrow/:taskId/dispute ────────────────────────────────────────
router.post("/:taskId/dispute", (req, res) => {
  const { taskId } = req.params;
  const { reason, userId } = req.body as { reason: string; userId: string };
  const record = escrowStore.get(taskId);
  if (!record) { res.status(404).json({ error: "Escrow not found" }); return; }
  if (record.requesterId !== userId && record.helperId !== userId) {
    res.status(403).json({ error: "Only task participants can dispute" }); return;
  }
  if (record.status !== "held") { res.status(409).json({ error: `Cannot dispute escrow in ${record.status} state` }); return; }
  record.status = "disputed";
  record.disputedAt = new Date().toISOString();
  record.disputeReason = reason;
  req.log.info({ taskId, reason }, "Escrow dispute opened");
  res.json(record);
});

// ─── POST /api/escrow/:escrowId/resolve-dispute ───────────────────────────────
router.post("/:escrowId/resolve-dispute", (req, res) => {
  const { escrowId } = req.params;
  const { releaseToHelper } = req.body as { releaseToHelper: boolean };
  const record = [...escrowStore.values()].find((r) => r.id === escrowId);
  if (!record) { res.status(404).json({ error: "Escrow not found" }); return; }
  if (record.status !== "disputed") { res.status(409).json({ error: "Escrow is not disputed" }); return; }
  record.status = releaseToHelper ? "released" : "refunded";
  record.releasedAt = new Date().toISOString();
  req.log.info({ escrowId, releaseToHelper }, "Dispute resolved");
  res.json(record);
});

// ─── GET /api/escrow/:taskId ──────────────────────────────────────────────────
router.get("/:taskId", (req, res) => {
  const record = escrowStore.get(req.params.taskId);
  if (!record) { res.status(404).json({ error: "Escrow not found" }); return; }
  res.json(record);
});

// ─── GET /api/escrow/user/:userId ─────────────────────────────────────────────
router.get("/user/:userId", (req, res) => {
  const { userId } = req.params;
  const records = [...escrowStore.values()].filter(
    (r) => r.requesterId === userId || r.helperId === userId
  );
  res.json(records);
});

// ─── GET /api/escrow (admin only) ─────────────────────────────────────────────
router.get("/", (_req, res) => {
  const all = [...escrowStore.values()];
  const revenue = all
    .filter((r) => r.status === "released")
    .reduce((s, r) => s + r.platformFee, 0);
  res.json({ records: all, platformRevenue: revenue });
});

export default router;
