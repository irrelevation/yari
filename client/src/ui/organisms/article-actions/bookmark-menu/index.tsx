import React, { useEffect, useState } from "react";

import { Button } from "../../../atoms/button";
import { Doc } from "../../../../../../libs/types/document";
import { useOnlineStatus } from "../../../../hooks";
import {
  Item,
  useCollections,
  useBookmark,
  NewItem,
  useItemAdd,
  useItemDelete,
  useItemEdit,
  combineMutationStatus,
} from "../../../../plus/collections/api";
import NewEditCollectionModal from "../../../../plus/collections/new-edit-collection-modal";
import { DropdownMenu, DropdownMenuWrapper } from "../../../molecules/dropdown";
import { Icon } from "../../../atoms/icon";
import NoteCard from "../../../molecules/notecards";
import { useGleanClick } from "../../../../telemetry/glean-context";
import {
  ARTICLE_ACTIONS_COLLECTION_SELECT_OPENED,
  ARTICLE_ACTIONS_NEW_COLLECTION,
  ARTICLE_ACTIONS_COLLECTIONS_OPENED,
  NEW_COLLECTION_MODAL_SUBMIT_ARTICLE_ACTIONS,
} from "../../../../telemetry/constants";

const addValue = "add";

export default function BookmarkV2Menu({ doc }: { doc: Doc }) {
  const { data: collections } = useCollections();
  const { data: savedItems } = useBookmark(doc.mdn_url);

  const defaultItem: NewItem = {
    url: doc.mdn_url,
    title: doc.title,
    notes: "",
    collection_id: "",
  };

  const { isOffline } = useOnlineStatus();
  const [show, setShow] = useState(false);
  const [showNewCollection, setShowNewCollection] = useState(false);
  const [focusEventTriggered, setFocusEventTriggered] = useState(false);

  const [disableAutoClose, setDisableAutoClose] = useState(false);
  const [formItem, setFormItem] = useState<Item | NewItem>(defaultItem);
  const [lastAction, setLastAction] = useState("");
  const gleanClick = useGleanClick();
  const { mutator: addItem, ...addStatus } = useItemAdd();
  const { mutator: editItem, ...editStatus } = useItemEdit();
  const { mutator: deleteItem, ...deleteStatus } = useItemDelete();
  const { resetErrors, errors, isPending } = combineMutationStatus(
    addStatus,
    editStatus,
    deleteStatus
  );

  useEffect(() => {
    if (collections && formItem.collection_id === "") {
      setFormItem({ ...formItem, collection_id: collections[0].id });
    }
  }, [collections, formItem]);

  useEffect(() => {
    if (savedItems?.length) setFormItem(savedItems[0]);
  }, [savedItems]);

  useEffect(() => {
    if (showNewCollection === false) {
      setDisableAutoClose(false);
    }
  }, [showNewCollection]);

  const collectionChangeHandler = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const { value } = e.target;
    if (value === addValue) {
      gleanClick(ARTICLE_ACTIONS_NEW_COLLECTION);
      setDisableAutoClose(true);
      setShowNewCollection(true);
      changeHandler(e);
    } else {
      const item = savedItems?.find((item) => item.collection_id === value);
      const previousItem = savedItems?.find(
        (item) => item.collection_id === formItem.collection_id
      );
      const modifiedNotes =
        savedItems && previousItem?.notes !== formItem.notes;
      const modifiedTitle =
        savedItems && previousItem?.title !== formItem.title;
      setFormItem(
        item || {
          ...defaultItem,
          collection_id: value,
          notes: modifiedNotes ? formItem.notes : defaultItem.notes,
          title: modifiedTitle ? formItem.title : defaultItem.title,
        }
      );
    }
  };

  const changeHandler = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    e.preventDefault();
    const { name, value } = e.target;
    setFormItem({ ...formItem, [name]: value });
  };

  const cancelHandler = (e: React.MouseEvent) => {
    e.preventDefault();
    setFormItem(savedItems?.[0] || defaultItem);
    setShow(false);
  };

  const isCurrentInCollection = () =>
    savedItems?.length &&
    savedItems.some((item) => item.collection_id === formItem.collection_id);

  const saveHandler = async (
    e: React.FormEvent<HTMLFormElement> | React.BaseSyntheticEvent
  ) => {
    e.preventDefault();
    if (!collections || isPending) return;
    setLastAction("save");
    resetErrors();
    if ("id" in formItem && isCurrentInCollection()) {
      await editItem(formItem);
    } else {
      await addItem(formItem);
    }
    setShow(false);
  };

  const enterHandler = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveHandler(e);
    }
  };

  const deleteHandler = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!collections || isPending) return;
    setLastAction("delete");
    resetErrors();
    if (isCurrentInCollection()) {
      const selectedItem = savedItems?.find(
        (item) => item.collection_id === formItem.collection_id
      );
      if (selectedItem) {
        await deleteItem(selectedItem);
      }
    }
    setFormItem(defaultItem);
    setShow(false);
  };

  return (
    <DropdownMenuWrapper
      isOpen={show}
      setIsOpen={setShow}
      disableAutoClose={disableAutoClose}
    >
      {doc ? (
        <Button
          type="action"
          isDisabled={isOffline}
          icon={savedItems?.length ? "bookmark-filled" : "bookmark"}
          extraClasses={`bookmark-button small ${
            savedItems?.length ? "highlight" : ""
          }`}
          onClickHandler={() => {
            setShow((v) => !v);
            if (!show) {
              gleanClick(ARTICLE_ACTIONS_COLLECTIONS_OPENED);
            }
          }}
        >
          <span className="bookmark-button-label">
            {savedItems?.length ? "Saved" : "Save"}
          </span>
        </Button>
      ) : (
        <Button
          icon="edit"
          type="action"
          isDisabled={isOffline}
          title="Edit"
          onClickHandler={() => {
            setShow((v) => !v);
          }}
        >
          <span className="visually-hidden">Edit bookmark</span>
        </Button>
      )}
      <form className="mdn-form" method="post" onSubmit={saveHandler}>
        <DropdownMenu>
          <div
            className={`article-actions-submenu show ${
              isPending ? "wait" : ""
            }`}
            role="menu"
          >
            <button onClick={cancelHandler} className="header mobile-only">
              <span className="header-inner">
                <Icon name="chevron" />
                {savedItems?.length ? "Edit Item" : "Add to Collection"}
              </span>
            </button>

            <h2 className="header desktop-only">
              {savedItems?.length ? "Edit Item" : "Add to Collection"}
            </h2>

            {Boolean(errors.length) && (
              <NoteCard type="error">
                <p>Error: {errors[0]?.message}</p>
              </NoteCard>
            )}

            <div className="mdn-form-item">
              <label htmlFor="bookmark-collection">Collection:</label>
              <div className="select-wrap">
                <select
                  id="bookmark-collection"
                  name="collection_id"
                  value={formItem.collection_id}
                  autoComplete="off"
                  onChange={collectionChangeHandler}
                  onFocus={() => {
                    if (!focusEventTriggered) {
                      gleanClick(ARTICLE_ACTIONS_COLLECTION_SELECT_OPENED);
                      setFocusEventTriggered(true);
                    }
                  }}
                  disabled={!collections || isPending}
                >
                  {collections?.map((collection) => (
                    /** Todo remove hard coded name post Migration */
                    <option key={collection.id} value={collection.id}>
                      {savedItems?.some(
                        (item) => item.collection_id === collection.id
                      )
                        ? "★"
                        : "☆"}{" "}
                      {collection.name === "Default"
                        ? "Saved Articles"
                        : collection.name}
                    </option>
                  )) || <option>Loading...</option>}
                  <option disabled={true} role="separator">
                    ——————————
                  </option>
                  <option value={addValue}>+ New Collection</option>
                </select>
              </div>
            </div>
            <div className="mdn-form-item">
              <label htmlFor="bookmark-title">Name:</label>
              <input
                id="bookmark-title"
                name="title"
                value={formItem.title}
                autoComplete="off"
                type="text"
                onChange={changeHandler}
                onKeyDown={enterHandler}
                disabled={isPending}
              />
            </div>
            <div className="mdn-form-item">
              <label htmlFor="bookmark-note">Note:</label>
              <input
                id="bookmark-note"
                name="notes"
                type="text"
                autoComplete="off"
                value={formItem.notes}
                onChange={changeHandler}
                onKeyDown={enterHandler}
                disabled={isPending}
              />
            </div>
            <div className="mdn-form-item is-button-row">
              <Button
                buttonType="submit"
                isDisabled={!collections || isPending}
              >
                {isPending && lastAction === "save" ? "Saving..." : "Save"}
              </Button>
              {savedItems?.length ? (
                <Button
                  type="secondary"
                  onClickHandler={deleteHandler}
                  isDisabled={
                    !collections || isPending || !isCurrentInCollection()
                  }
                >
                  {isPending && lastAction === "delete"
                    ? "Deleting..."
                    : "Delete"}
                </Button>
              ) : (
                <Button
                  onClickHandler={cancelHandler}
                  isDisabled={!collections || isPending}
                  type="secondary"
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </DropdownMenu>
      </form>
      {collections && (
        <NewEditCollectionModal
          show={showNewCollection}
          setShow={setShowNewCollection}
          onClose={(collection_id) => {
            setDisableAutoClose(false);
            setFormItem({
              ...formItem,
              collection_id: collection_id || collections[0].id,
            });
          }}
          source={NEW_COLLECTION_MODAL_SUBMIT_ARTICLE_ACTIONS}
        />
      )}
    </DropdownMenuWrapper>
  );
}
