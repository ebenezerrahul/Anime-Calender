const PORT = process.env.PORT || 3000;
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import ical, { ICalCalendar } from "ical-generator";
import { setTimeout } from "timers/promises";
const express = require("express");
const axios = require("axios");
const app = express();
// app.use(express.json());
const SimplDB = require("simpl.db");
const db = new SimplDB();
const Users = db.createCollection("users", {
  watch_list: [],
});
const Anime = db.createCollection("anime");

require("dotenv").config();
const apiKey = process.env.API_KEY;
console.log(apiKey);
axios.interceptors.request.use(
  (config) => {
    config.headers["X-MAL-CLIENT-ID"] = apiKey;
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || "Assertion failed");
  }
}

async function getMalWatchingList(username, callback) {
  assert(typeof username == "string", "username must be a string");
  const endpoint =
    "https://api.myanimelist.net/v2/users/" +
    username +
    "/animelist?status=watching";
  let watching_list = [];
  let collect_watching_list = function (endpoint) {
    axios
      .get(endpoint)
      .then((res) => {
        let data = res.data.data;
        for (let entry of data) {
          watching_list.push(entry);
        }
        if (res.data.paging.next) {
          const next = res.data.paging.next;
          collect_watching_list(next);
        } else {
          callback(watching_list, null);
        }
      })
      .catch((err) => callback(null, err));
  };
  collect_watching_list(endpoint);
  return watching_list;
}
function updateAnimeAiringTime(title, time) {
  Anime.update(
    (anime) => (anime.next_airing_time = time),
    (target) => target.title === title,
  );
}
console.log(new Date());

async function getAiringTime(title, callback) {
  var query = `
  query($title : String) {
    Media(search : $title) {
    id
    idMal
    title {
      romaji
      english
      native
    }
    nextAiringEpisode {
      airingAt
      timeUntilAiring
    }
    }}
`;
  var variables = {
    title: title,
  };

  axios
    .post("https://graphql.anilist.co", {
      query: query,
      variables: variables,
    })
    .then((res) => {
      const data = res.data.data;
      const media = data.Media;
      if (media.nextAiringEpisode != null) {
        let entry = {
          title: title,
          time: media.nextAiringEpisode,
        };
        callback(entry.time, null);
      } else {
        // console.log(media);
        callback(null, "Airing Time notpresent on Anilist");
      }
    })
    .catch(console.log);
}

function trackList(list) {
  for (let entry of list) {
    let anime = Anime.getOrCreate((anime) => anime.title == entry, {
      title: entry,
      next_airing_time: null,
    });
    // console.log("anime:", anime);
    if (anime.next_airing_time == null) {
      getAiringTime(entry, (time, err) => {
        if (err != null) {
          console.log("here", err);
          return;
        }
        console.log("calling updateAnimeAiringTime");
        updateAnimeAiringTime(anime.title, time);
      });
    }
  }
}

function addUser(username) {
  Users.create({
    username: username,
    watch_list: [],
  });
  getMalWatchingList(username, (list, err) => {
    if (err) {
      console.log(err);
      return;
    }
    // console.log("list", list);
    let new_list = [];
    for (const entry of list) {
      new_list.push(entry.node.title);
    }
    Users.update(
      (user) => {
        user.watch_list = new_list;
      },
      (target) => target.username === username,
    );
    console.log(new_list);
    trackList(new_list);
  });
}

function refreshWatchList() {
  const users = Users.getAll();
  for (const user of users) {
    const username = user.username;
    getMalWatchingList(username, (list, err) => {
      if (err) {
        console.log(err);
        return;
      }

      let new_list = [];

      for (const entry of list) {
        new_list.push(entry.node.title);
      }

      Users.update(
        (user) => {
          user.watch_list = new_list;
        },
        (target) => target.username === username,
      );

      trackList(new_list);
    });
  }
}

function refreshAllAiringTimes() {
  Anime.remove(); // NOTE:removing all entries
  const users = Users.getAll();
  for (const user of users) {
    trackList(user.watch_list);
  }
}

function createIcal(username) {
  const user = Users.get((user) => user.username == username);
  const list = user.watch_list;
  const ical = new ICalCalendar();
  for (const entry of list) {
    const anime = Anime.get((anime) => anime.title === entry);
    let next_airing_time = anime?.next_airing_time;
    if (next_airing_time != null && next_airing_time != undefined) {
      const time = next_airing_time.airingAt;
      let d = new Date(0);
      d.setUTCSeconds(time);
      ical.createEvent({
        // start: anime.next_airing_time,
        start: d,
        summary: anime.title,
      });
    }
  }
  return ical;
}

setInterval(refreshWatchList, 24 * 60 * 60 * 1000);
setInterval(refreshAllAiringTimes, 8 * 60 * 60 * 1000);

app.get("/subscribe/:username", (req, res) => {
  const params = req.params;
  const username = params.username;
  assert(typeof username == "string", "check your url correctly");
  if (Users.has((u) => u.username === username)) {
    const ical = createIcal(username);
    console.log(ical.toString());
    res.set({
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'inline; filename="calendar.ics"',
    });
    res.send(ical.toString());
  } else {
    addUser(username);
  }
});
app.get("/", () => {});

app.listen(PORT, () => {
  console.log("Server Listening on PORT:", PORT);
});
