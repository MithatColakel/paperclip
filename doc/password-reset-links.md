# Password reset links (fork)

Paperclip runs Better Auth with email and password, but without a reset e-mail,
an admin plugin or a change-password page. A member who forgets their password
gets back in through a one-time link that an owner creates and hands over, the
same way as an invite link.

## Who can create a link

The password belongs to the user, not to a company. Whoever opens the link can
sign in to every company the user belongs to. So:

- An **owner** of a company can create a link for a member of that company only
  when the owner also owns **every** company the member is an active member of.
- An **instance admin** can create a link for any active member, except
  themselves.
- Nobody creates a link for themselves.
- Owners and instance admins can only be reset by an instance admin.
- Agents cannot create links.

The server checks these rules again when the link is used. If the member joined
a company the creator does not own, or the creator lost ownership, the link no
longer works.

## How it works

1. Company settings → Members → **Reset password** on the member's row. When the
   button is disabled, its tooltip says why.
2. **Create link** copies the link. Send it to the member over a private channel.
3. The member opens `/reset-password/<token>` (no sign-in needed) and picks a
   new password: 8 to 128 characters.
4. The member is signed out on every device and signs in with the new password.

A link works once, for 24 hours. A new link for the same member revokes the
older one. Only the SHA-256 of the token is stored, in
`user_password_reset_links`. The public endpoints send `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`, and are rate-limited per IP like invites.

## API

| Method and path | Who | What |
| --- | --- | --- |
| `GET /api/companies/:companyId/password-reset-access` | board | Whether the viewer can create links, and per member why not |
| `POST /api/companies/:companyId/members/:memberId/password-reset-links` | board | Creates a link; returns `resetUrl` once |
| `GET /api/password-reset/:token` | public | The member's e-mail, company, creator and expiry |
| `POST /api/password-reset/:token` `{ password }` | public | Sets the password, deletes the member's sessions |

## Activity log

Both entries go to the company the link was created from. Neither contains the
token.

- `user.password_reset_link_created`: actor is the creator; details hold
  `linkId`, `expiresAt` and `revokedPreviousCount`.
- `user.password_reset_completed`: actor is the member; details hold `linkId`,
  `createdByUserId` and `revokedSessionCount`.

## Not covered

- Board API keys (CLI logins) of the member stay valid after a reset.
- An instance admin's own password still needs a reset on the server, outside
  the app.
