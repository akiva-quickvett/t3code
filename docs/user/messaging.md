# Messaging

Messaging connects an environment to a WhatsApp Business number, so the
environment can message the people you list as contacts. Set it up in
**Settings → Integrations → Messaging**. The section appears only when the
selected environment's server supports it.

## Add a WhatsApp channel

Choose **Add WhatsApp channel** and give it a name. A notify template (below)
also needs the WhatsApp Business Account ID, so T3 Code can check that the
template is approved.

Then set each credential with its **Set** button: the access token, the phone
number ID, the app secret and the webhook verify token, all from your Meta app.
Each value goes straight to the environment's secret store. T3 Code never shows
it again, only whether it is set and when it last changed; use **Replace** to
change one. The app secret must be the 32-character hexadecimal secret from the
app's settings.

**Remove channel** deletes the channel, its credentials, its contacts, their
message log and anything still waiting to be sent.

## Contacts

A channel only messages its contacts. Add each person with a name, a short
lowercase slug and their phone numbers in international format, such as
`+1 555 0100`. After saving, numbers show only their last two digits. When you
edit a contact, leave the numbers empty to keep the ones stored.

## The 24-hour window

WhatsApp allows free-form messages only within 24 hours of the person's last
message. A message sent outside that window waits and goes out when the person
next writes. To let them know something is waiting, set a notify template on
the channel. It must be a template Meta has approved in the **UTILITY**
category: Meta does not deliver MARKETING templates to US numbers. Use
**Check status** to see whether it is approved.

## Production access

**Production access for investigation pods** says how investigation pods may
reach production. It is off by default. **Railway (write-capable)** gives
investigation pods the Railway login, which can change production; reading
only is a convention it cannot enforce. The read-only database URL option is
not available yet.
