<?php
/**
 * Demo seed for the FreeScout cookie-session MCP.
 *
 * Runs inside the freescout-demo container as the `nginx` user (owner of /www/html):
 *
 *   docker cp demo/seed.php freescout-demo:/tmp/seed.php
 *   docker exec -u nginx -e AGENT_PASS="$AGENT_PASS" -e DEMO_DOMAIN=freescout.example.com freescout-demo php /tmp/seed.php [--reset]
 *
 * --reset deletes ALL conversations, threads, customers, drafts, notifications and
 * send logs before reseeding (mailboxes and users are kept and updated in place).
 * Without --reset the script refuses to run if conversations already exist.
 *
 * Contains no secrets: the agent password comes from the AGENT_PASS env var. DEMO_DOMAIN (the demo
 * hostname, default freescout.example.com) sets the user and mailbox email domain.
 */

require '/www/html/vendor/autoload.php';
$app = require '/www/html/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use App\Conversation;
use App\Customer;
use App\Folder;
use App\Mailbox;
use App\Option;
use App\Thread;
use App\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

$reset = in_array('--reset', $argv);
$domain = getenv('DEMO_DOMAIN') ?: 'freescout.example.com';
$agentPass = getenv('AGENT_PASS');
if (!$agentPass) {
    fwrite(STDERR, "AGENT_PASS env var is required\n");
    exit(1);
}

if (Conversation::count() > 0) {
    if (!$reset) {
        fwrite(STDERR, "Conversations already exist. Re-run with --reset to wipe and reseed.\n");
        exit(1);
    }
    DB::table('conversation_folder')->delete();
    DB::table('followers')->delete();
    DB::table('attachments')->delete();
    DB::table('threads')->delete();
    DB::table('conversations')->delete();
    DB::table('emails')->delete();
    DB::table('customers')->delete();
    DB::table('send_logs')->delete();
    DB::table('notifications')->delete();
    DB::table('jobs')->delete();
    DB::table('failed_jobs')->delete();
    // Deterministic ids after a reset (docs/demo.md lists them).
    foreach (['conversations', 'threads', 'customers', 'emails', 'send_logs', 'jobs', 'attachments', 'followers'] as $table) {
        DB::statement("ALTER TABLE `$table` AUTO_INCREMENT = 1");
    }
}

// ---------------------------------------------------------------- mail lockdown
// System mail (user notifications, invites) -> Laravel "log" transport: written to the log, never sent.
Option::set('mail_driver', 'log');
Option::set('mail_host', '127.0.0.1');
Option::set('mail_port', '2525');

// ---------------------------------------------------------------- mailboxes
function demoMailbox($name, $email)
{
    $mb = Mailbox::where('email', $email)->first() ?: new Mailbox();
    $mb->name = $name;
    $mb->email = $email;
    // Customer-facing mail goes to SMTP on a closed local port: every send fails, nothing leaves the box.
    $mb->out_method = Mailbox::OUT_METHOD_SMTP;
    $mb->out_server = '127.0.0.1';
    $mb->out_port = 2525;
    $mb->out_username = null;
    $mb->out_password = null;
    $mb->save(); // MailboxObserver::created builds public + admin personal folders
    return $mb;
}

$support = demoMailbox('Support', 'support@'.$domain);
$billing = demoMailbox('Billing', 'billing@'.$domain);

// ---------------------------------------------------------------- users
$admin = User::where('email', 'admin@'.$domain)->firstOrFail();

$agent = User::where('email', 'agent@'.$domain)->first() ?: new User();
$agent->email = 'agent@'.$domain;
$agent->first_name = 'Demo';
$agent->last_name = 'Agent';
$agent->role = User::ROLE_USER;
$agent->status = User::STATUS_ACTIVE;
$agent->invite_state = User::INVITE_STATE_ACTIVATED;
$agent->password = Hash::make($agentPass);
$agent->save();

// Support only.
$support->users()->syncWithoutDetaching([$agent->id]);
$billing->users()->detach($agent->id);
$support->syncPersonalFolders([$agent->id]);
$support->syncPersonalFolders();
$billing->syncPersonalFolders();
// Admins get personal folders in every mailbox.
Mailbox::createAdminPersonalFoldersAllMailboxes();

// ---------------------------------------------------------------- helpers
function demoCustomer($email, $first, $last, $company = null)
{
    return Customer::create($email, array_filter([
        'first_name' => $first,
        'last_name'  => $last,
        'company'    => $company,
    ]));
}

/**
 * $threads: list of [kind, body, minutesAgo, userForAgentThreads]
 *   kind: 'customer' | 'reply' | 'note'
 */
function demoConversation(Mailbox $mailbox, Customer $customer, $subject, $status, $assignee, array $threads, $closedBy = null)
{
    global $domain;
    $email = $customer->getMainEmail();

    $firstAt = date('Y-m-d H:i:s', time() - $threads[0][2] * 60);

    $c = new Conversation();
    $c->type = Conversation::TYPE_EMAIL;
    $c->subject = $subject;
    $c->mailbox_id = $mailbox->id;
    $c->customer_id = $customer->id;
    $c->customer_email = $email;
    $c->created_by_customer_id = $customer->id;
    $c->status = $status;
    $c->state = Conversation::STATE_PUBLISHED;
    $c->source_via = Conversation::PERSON_CUSTOMER;
    $c->source_type = Conversation::SOURCE_TYPE_EMAIL;
    $c->user_id = $assignee ? $assignee->id : null;
    $c->preview = '';
    $c->created_at = $firstAt;
    $c->updateFolder();
    $c->save();

    $lastReplyAt = null;
    $lastReplyFrom = null;
    $lastCustomerAt = null;
    $lastUserAt = null;
    foreach ($threads as $i => $t) {
        list($kind, $body, $minutesAgo) = $t;
        $by = $t[3] ?? null;
        $at = date('Y-m-d H:i:s', time() - $minutesAgo * 60);

        $th = new Thread();
        $th->conversation_id = $c->id;
        $th->user_id = $c->user_id;
        $th->status = $status;
        $th->state = Thread::STATE_PUBLISHED;
        $th->body = $body;
        $th->customer_id = $customer->id;
        $th->first = ($i == 0);
        $th->created_at = $at;
        $th->updated_at = $at;
        if ($kind == 'customer') {
            $th->type = Thread::TYPE_CUSTOMER;
            $th->source_via = Thread::PERSON_CUSTOMER;
            $th->source_type = Thread::SOURCE_TYPE_EMAIL;
            $th->created_by_customer_id = $customer->id;
            $th->from = $email;
            $th->setTo($mailbox->email);
            $th->message_id = 'demo-'.$c->id.'-'.$i.'@customer.example';
            $lastReplyAt = $at;
            $lastReplyFrom = Conversation::PERSON_CUSTOMER;
            $lastCustomerAt = $at;
        } else {
            $th->type = ($kind == 'note') ? Thread::TYPE_NOTE : Thread::TYPE_MESSAGE;
            $th->source_via = Thread::PERSON_USER;
            $th->source_type = Thread::SOURCE_TYPE_WEB;
            $th->created_by_user_id = $by->id;
            if ($kind == 'reply') {
                $th->setTo($email);
                $th->message_id = 'demo-'.$c->id.'-'.$i.'@'.$domain;
                // Mark as already sent so nothing is queued for it.
                $th->send_status = \App\SendLog::STATUS_ACCEPTED;
                $lastReplyAt = $at;
                $lastReplyFrom = Conversation::PERSON_USER;
            }
            $lastUserAt = $at;
        }
        $th->save(); // ThreadObserver updates threads_count + preview
    }

    // ThreadObserver stamps "now"; restore realistic times.
    $c->refresh();
    $c->last_reply_at = $lastReplyAt;
    $c->last_reply_from = $lastReplyFrom;
    $c->last_customer_reply_at = $lastCustomerAt;
    $c->user_updated_at = $lastUserAt;
    $c->read_by_user = ($lastReplyFrom == Conversation::PERSON_USER);
    if ($status == Conversation::STATUS_CLOSED) {
        $c->closed_by_user_id = ($closedBy ?: $assignee ?: User::where('role', User::ROLE_ADMIN)->first())->id;
        $c->closed_at = $lastReplyAt ?: $firstAt;
    }
    $c->updated_at = $lastReplyAt ?: $firstAt;
    $c->timestamps = false;
    $c->updateFolder();
    $c->save();
    $c->timestamps = true;

    return $c;
}

$A = Conversation::STATUS_ACTIVE;
$P = Conversation::STATUS_PENDING;
$C = Conversation::STATUS_CLOSED;

// ---------------------------------------------------------------- customers
$maria  = demoCustomer('maria.lopez@brightpath.example', 'Maria', 'Lopez', 'BrightPath Analytics');
$tom    = demoCustomer('tom.becker@northwind.example', 'Tom', 'Becker', 'Northwind Logistics');
$aisha  = demoCustomer('aisha.khan@lumenlabs.example', 'Aisha', 'Khan', 'Lumen Labs');
$dev    = demoCustomer('devops@acme-retail.example', 'Priya', 'Natarajan', 'Acme Retail');
$jonas  = demoCustomer('jonas.berg@fjordsoft.example', 'Jonas', 'Berg', 'Fjordsoft');
$li     = demoCustomer('li.wei@pixelforge.example', 'Li', 'Wei', 'PixelForge Studio');
$sam    = demoCustomer('sam.oconnor@gmail.example', 'Sam', "O'Connor");
$elena  = demoCustomer('elena.rossi@verdeco.example', 'Elena', 'Rossi', 'Verde Co');
$carlos = demoCustomer('carlos.mendes@tidepool.example', 'Carlos', 'Mendes', 'Tidepool Media');
$finance = demoCustomer('accounts@harborfreight-co.example', 'Grace', 'Liu', 'Harbor Freight Co');

// ---------------------------------------------------------------- Support conversations
$out = [];

$out['support_unassigned_login'] = demoConversation($support, $maria,
    "Can't log in after password reset", $A, null, [
    ['customer', "<p>Hi team,</p><p>I reset my password this morning using the link you emailed, but now every login attempt says <em>\"Invalid credentials\"</em>. I've tried in Chrome and Firefox and cleared cookies. Our weekly report is due today, can you help?</p><p>Thanks,<br>Maria</p>", 180],
]);

$out['support_mine_webhooks_starred'] = demoConversation($support, $dev,
    'Webhook deliveries failing with 401 since yesterday', $A, $agent, [
    ['customer', "<p>Hello,</p><p>Since about 14:00 UTC yesterday all webhook deliveries to <code>https://hooks.acme-retail.example/orders</code> are failing with HTTP 401. We haven't changed anything on our side. Delivery IDs: <code>wh_8f2a91</code>, <code>wh_8f2a97</code>.</p><p>Priya</p>", 1500],
    ['reply', "<p>Hi Priya,</p><p>Thanks for the delivery IDs. We rotated webhook signing secrets yesterday for accounts that had the legacy HMAC-SHA1 setting. Could you check whether your endpoint validates the <code>X-Signature</code> header with the old secret? The new secret is under Settings &rarr; Webhooks.</p><p>Best,<br>Demo Agent</p>", 1380, $agent],
    ['customer', "<p>That was it, thanks. We updated the secret and new deliveries succeed. Can you replay the ones that failed between 14:00 and 18:00 UTC yesterday?</p>", 240],
]);

$out['support_mine_csv_pending'] = demoConversation($support, $jonas,
    'Feature request: export reports to CSV', $P, $agent, [
    ['customer', "<p>Hi! Is there any way to export the monthly usage report as CSV? Our finance team wants to pull it into their spreadsheets. PDF only is a bit limiting.</p><p>Jonas</p>", 4300],
    ['reply', "<p>Hi Jonas,</p><p>Not yet, but CSV export is on our roadmap for next quarter. I've added your vote to the request. In the meantime the <code>/v2/reports/usage</code> API endpoint returns the same data as JSON.</p><p>I'll keep this ticket pending and update you when it ships.</p><p>Demo Agent</p>", 4200, $agent],
]);

$out['support_unassigned_sso_note'] = demoConversation($support, $aisha,
    'SSO setup with Okta returns invalid_audience', $A, null, [
    ['customer', "<p>Hello,</p><p>We're configuring SAML SSO with Okta. After the IdP redirect we get <code>invalid_audience</code>. Audience URI in Okta is set to <code>https://app.example.com/saml/metadata</code>. Screenshot of the error attached in our internal ticket LUM-2231.</p><p>Aisha Khan<br>IT, Lumen Labs</p>", 600],
    ['note', "<p>Internal: Lumen Labs is on the Enterprise plan, SSO was enabled by sales last week. Audience should be the workspace-specific URI (<code>https://app.example.com/saml/lumenlabs</code>), not the generic metadata URL. Needs someone with SSO admin access to confirm before replying.</p>", 560, $admin],
]);

$out['support_mine_teammates_closed'] = demoConversation($support, $li,
    'How do I add teammates to my workspace?', $C, $agent, [
    ['customer', "<p>Hey, just upgraded to the Team plan. Where do I invite my colleagues?</p><p>Li</p>", 10100],
    ['reply', "<p>Hi Li,</p><p>Congrats on the upgrade! Go to <strong>Settings &rarr; Members &rarr; Invite</strong>, enter their emails and pick a role. Invites expire after 7 days.</p><p>Demo Agent</p>", 10000, $agent],
    ['customer', "<p>Found it, all three are in. Thanks!</p>", 9900],
]);

$out['support_assigned_admin_ratelimit'] = demoConversation($support, $tom,
    'API rate limit hit at 100 req/min', $A, $admin, [
    ['customer', "<p>Hi,</p><p>Our nightly sync job is getting <code>429 Too Many Requests</code> after roughly 100 requests per minute. Our contract says 600/min. Can you check our account limits? Account ID: NW-44120.</p><p>Tom Becker</p>", 900],
    ['reply', "<p>Hi Tom,</p><p>Looking into this now. It looks like the limit on your API key was not updated when the contract changed. I've asked engineering to raise it and will confirm shortly.</p><p>Demo Admin</p>", 840, $admin],
]);

$out['support_unassigned_android_pending'] = demoConversation($support, $sam,
    'Mobile app crashes on Android 15 when uploading photos', $P, null, [
    ['customer', "<p>The app closes immediately whenever I try to attach a photo from the gallery. Pixel 8, Android 15, app version 4.12.0. Reinstalling didn't help.</p><p>Sam</p>", 2900],
    ['reply', "<p>Hi Sam,</p><p>Sorry about that. This is a known issue with the Android 15 photo picker and a fix is in version 4.12.2, which is rolling out this week. Could you let us know if updating resolves it?</p><p>Demo Admin</p>", 2800, $admin],
]);

$out['support_closed_gdpr'] = demoConversation($support, $elena,
    'Data deletion request (GDPR Art. 17)', $C, $admin, [
    ['customer', "<p>Under GDPR Article 17 I request deletion of all personal data associated with elena.rossi@verdeco.example.</p><p>Elena Rossi</p>", 20000],
    ['reply', "<p>Dear Elena,</p><p>We have completed your deletion request. All personal data linked to this address has been removed from our production systems; backups will roll off within 30 days.</p><p>Demo Admin</p>", 19000, $admin],
]);

$out['support_mine_safari_note'] = demoConversation($support, $carlos,
    'Dashboard charts not loading in Safari 18', $A, $agent, [
    ['customer', "<p>Hi, the charts on the analytics dashboard stay blank in Safari 18.1 on macOS Sequoia. Works fine in Chrome. Console shows <code>TypeError: undefined is not a function (near '...Intl.DurationFormat...')</code>.</p><p>Carlos</p>", 300],
    ['note', "<p>Reproduced on Safari 18.1. Intl.DurationFormat polyfill is missing from the charts bundle. Filed ENG-5823.</p>", 120, $agent],
    ['reply', "<p>Hi Carlos,</p><p>Thanks for the console output, that pinpointed it. We've reproduced the issue and our engineers are working on a fix. As a workaround, Chrome or Firefox will display the charts correctly.</p><p>Demo Agent</p>", 110, $agent],
]);

// Starred by the agent (personal Starred folder).
$out['support_mine_webhooks_starred']->star($agent);

// ---------------------------------------------------------------- Billing conversations
$out['billing_unassigned_double_charge'] = demoConversation($billing, $finance,
    'Charged twice for October invoice', $A, null, [
    ['customer', "<p>Hello,</p><p>Our card was charged twice for invoice INV-2026-1043 ($480.00) on Oct 1. Please refund the duplicate charge.</p><p>Grace Liu<br>Accounts, Harbor Freight Co</p>", 700],
]);

$out['billing_pending_upgrade'] = demoConversation($billing, $jonas,
    'Upgrade from Starter to Pro mid-cycle: how is it prorated?', $P, $admin, [
    ['customer', "<p>If we upgrade from Starter to Pro on the 15th, do we pay the full Pro price this month or is it prorated?</p><p>Jonas</p>", 3000],
    ['reply', "<p>Hi Jonas, upgrades are prorated to the day. You'd pay the Pro difference for the remaining 16 days. Want me to apply it now?</p><p>Demo Admin</p>", 2950, $admin],
]);

$out['billing_closed_vat'] = demoConversation($billing, $elena,
    'Request VAT invoice for 2026 Q3', $C, $admin, [
    ['customer', "<p>Could you send a VAT-compliant invoice for Q3 2026 with our VAT ID IT01234567890?</p><p>Elena</p>", 15000],
    ['reply', "<p>Hi Elena, the VAT invoice is now available under Billing &rarr; Invoices. Let us know if anything needs correcting.</p><p>Demo Admin</p>", 14800, $admin],
]);

// ---------------------------------------------------------------- counters
$support->updateFoldersCounters();
$billing->updateFoldersCounters();
\Cache::flush();

// ---------------------------------------------------------------- summary
$summary = [
    'mailboxes' => ['Support' => $support->id, 'Billing' => $billing->id],
    'users' => ['admin' => $admin->id, 'agent' => $agent->id],
    'folders' => [],
    'conversations' => [],
];
foreach ([$support, $billing] as $mb) {
    foreach (Folder::where('mailbox_id', $mb->id)->orderBy('id')->get() as $f) {
        $summary['folders'][] = [
            'id' => $f->id, 'mailbox' => $mb->name, 'type' => $f->type, 'user_id' => $f->user_id,
            'total' => $f->total_count, 'active' => $f->active_count,
        ];
    }
}
foreach ($out as $key => $c) {
    $c->refresh();
    $summary['conversations'][$key] = [
        'id' => $c->id, 'number' => $c->number, 'mailbox_id' => $c->mailbox_id,
        'status' => $c->status, 'user_id' => $c->user_id, 'folder_id' => $c->folder_id,
        'threads' => Thread::where('conversation_id', $c->id)->orderBy('id')->get(['id', 'type'])->toArray(),
    ];
}
echo json_encode($summary, JSON_PRETTY_PRINT), "\n";
