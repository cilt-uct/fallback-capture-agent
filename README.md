# Node.js Fallback Capture Agent
Node.js fallback recorder for Opencast. Records rtsp streams for those Capture Agents in an unhealthy state.

## Requirements
* ffmpeg 3.4.1 (earlier versions may work, depending on build parameters)
* Node.js 8+

## How this application works
1. Retrieve the list of upcoming events via /admin-ng/event/events.json?filter=[start date within some range]
2. For each of the capture agents returned in the previous request, note their state, rtsp stream source and
   time since last update (using /capture-admin/agents/[agent].json)
3. If the rtsp stream has no attached audio channel, skip recording the event.
4. If the agent has not updated itself in over 5 minutes, immediately queue the recording to initiate at the
   allotted start time.
5. If the agent has a state other than "idle" or "capturing", schedule a check to determine whether the 
   capture agent has indeed begun recording shortly after the start of the event. Thereafter, if the capture
   agent still has not begun recording, immediately start recording the event.

## Other
A simple webpage is provided to view the list of current recordings taking place.
