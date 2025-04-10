import { useEffect } from "react";
import { mutate } from "swr";
import { HEADER_NOTIFICATIONS_MENU_API_URL } from "../../constants";
import {
  markNotificationsAsRead,
  NOTIFICATIONS_MARK_ALL_AS_READ_PATH,
} from "../common/api";

export async function post(url: string, data?: object) {
  const fetchData: { method: string; headers: HeadersInit; body?: string } = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  };
  if (data) fetchData.body = JSON.stringify(data);

  const response = await fetch(url, fetchData);

  if (!response.ok) {
    throw new Error(`${response.status} on ${response.url}`);
  }
  return true;
}

export function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(";").shift();
}

function registerSendBeaconHandler() {
  // if the user clicks a hard link, we set notifications as read using a sendBeacon request
  const handler = () => {
    if (document.visibilityState === "hidden") {
      navigator.sendBeacon(NOTIFICATIONS_MARK_ALL_AS_READ_PATH);
    }
  };
  document.addEventListener("visibilitychange", handler);
  return handler;
}

export function useVisibilityChangeListener() {
  return useEffect(() => {
    const visibilityChangeHandler = registerSendBeaconHandler();

    return () => {
      // if the user clicks a react-router Link, we remove the sendBeacon handler
      // and send a fetch request to mark notifications as read
      document.removeEventListener("visibilitychange", visibilityChangeHandler);
      markNotificationsAsRead().then(async () => {
        // await mutate(apiUrl);
        await mutate(HEADER_NOTIFICATIONS_MENU_API_URL);
      });
    };
  }, []);
}
