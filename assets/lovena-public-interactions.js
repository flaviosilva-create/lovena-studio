/* Safety net for published gifts and editor Preview Experience.
   The primary page handlers may be delayed by network/data bootstrapping; editor preview uses
   the same interaction fallback while leaving the editor's own controls untouched. */
(function () {
  "use strict";
  var query = new URLSearchParams(window.location.search);
  var isPublicShare = query.has("slug");
  var isEditorExperience = query.get("edit") === "1" && !isPublicShare;
  /* The editor's Preview Experience uses this same page without a share slug.
     Install the fallback there too, but keep it dormant until preview mode starts. */
  if (!isPublicShare && !isEditorExperience) return;

  var fallbackPhotoIndex = 0;

  function textFor(value, index) {
    if (Array.isArray(value)) return value[index] == null ? "" : String(value[index]);
    if (value && typeof value === "object") {
      var key = index === 0 ? "title" : (index === 1 ? "copy" : "date");
      return value[key] == null ? "" : String(value[key]);
    }
    return "";
  }

  function showToast(message) {
    var toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(function () { toast.classList.remove("show"); }, 2600);
  }

  function showModal(title, copy, kicker, options) {
    var modal = document.getElementById("detailModal");
    if (!modal || typeof modal.showModal !== "function") return;
    options = options || {};
    var titleNode = document.getElementById("modalTitle");
    var copyNode = document.getElementById("modalCopy");
    var kickerNode = document.getElementById("modalKicker");
    var visual = document.getElementById("modalVisual");
    var envelope = document.getElementById("modalEnvelope");
    var extra = document.getElementById("modalExtra");
    if (titleNode) titleNode.textContent = title || "A Little Detail Just for Us";
    if (copyNode) copyNode.textContent = copy || "";
    if (kickerNode) kickerNode.textContent = kicker || "A LITTLE DETAIL JUST FOR US";
    if (visual) {
      visual.hidden = !options.photo;
      if (options.photo) {
        var photoVisual = options.photoElement && options.photoElement.querySelector(".gallery-photo");
        var computed = photoVisual ? window.getComputedStyle(photoVisual) : null;
        if (typeof options.photoUrl === "string" && /^(https?:\/\/|data:image\/)/i.test(options.photoUrl)) {
          visual.style.backgroundImage = "url(" + JSON.stringify(options.photoUrl) + ")";
          visual.style.backgroundSize = "cover";
          visual.style.backgroundPosition = "center";
        } else {
          visual.style.backgroundImage = computed && computed.backgroundImage && computed.backgroundImage !== "none"
            ? computed.backgroundImage : "var(--gallery-sprite)";
          visual.style.backgroundSize = computed && computed.backgroundSize ? computed.backgroundSize : "300% 200%";
          visual.style.backgroundPosition = computed && computed.backgroundPosition ? computed.backgroundPosition : "center";
        }
        visual.setAttribute("aria-label", title || "Photo");
      }
    }
    if (envelope) envelope.hidden = !options.envelope;
    if (extra) {
      extra.replaceChildren();
      if (options.signature) {
        var signature = document.createElement("div");
        signature.style.cssText = "font:22px Caveat,cursive;color:#936357;margin-top:6px";
        signature.textContent = options.signature;
        extra.appendChild(signature);
      }
    }
    if (!modal.open) modal.showModal();
  }

  function showPhoto(index, clickedElement) {
    var data = window.LOVENA_EDIT_DATA || {};
    var photos = Array.isArray(data.photos) ? data.photos : [];
    var row = document.getElementById("galleryRow");
    var trigger = clickedElement || (row && row.querySelector('[data-photo="' + index + '"]'));
    if (photos.length) {
      fallbackPhotoIndex = ((index % photos.length) + photos.length) % photos.length;
    } else {
      fallbackPhotoIndex = Math.max(0, index || 0);
    }
    var item = photos[fallbackPhotoIndex];
    var galleryImages = data.images && Array.isArray(data.images.gallery) ? data.images.gallery : [];
    var photoUrl = galleryImages[fallbackPhotoIndex];
    var caption = trigger && trigger.querySelector(".gallery-caption");
    var title = textFor(item, 0) || (caption && caption.textContent) || "A Special Moment";
    var copy = textFor(item, 1);
    showModal(title, copy, "OUR MOMENTS", { photo: true, photoElement: trigger, photoUrl: photoUrl });
  }

  function handleFallback(event) {
    // While the editor is actively editing, this fallback must not intercept clicks
    // used by the editor. Enable it only on public share pages or in Preview Experience.
    if (isEditorExperience && !document.body.classList.contains("lovena-preview-mode")) return;

    // Capture story controls before a delayed or stalled editor bootstrap can leave them inert.
    var target = event.target && event.target.closest ? event.target.closest(
      "[data-scroll], [data-photo], [data-milestone], [data-surprise], [data-action]"
    ) : null;
    if (!target) return;

    var action = target.getAttribute("data-action") || "";
    // Keep primary song playback and native share when its listener is active.
    if (window.LOVENA_PUBLIC_INTERACTIONS_READY === true && (action === "song-play" || action === "share-story")) return;
    var photo = target.closest("[data-photo]");
    var milestone = target.closest("[data-milestone]");
    var surprise = target.closest("[data-surprise]");
    var scrollButton = target.closest("[data-scroll]");

    if (action === "close-modal") {
      event.preventDefault();
      event.stopPropagation();
      var closeModal = document.getElementById("detailModal");
      if (closeModal && closeModal.open) closeModal.close();
      return;
    }

    if (scrollButton) {
      var destination = document.querySelector(scrollButton.getAttribute("data-scroll"));
      if (destination) {
        event.preventDefault();
        event.stopPropagation();
        destination.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    if (photo) {
      event.preventDefault();
      event.stopPropagation();
      showPhoto(Number(photo.getAttribute("data-photo")) || 0, photo);
      return;
    }

    if (milestone) {
      event.preventDefault();
      event.stopPropagation();
      var idx = Number(milestone.getAttribute("data-milestone")) || 0;
      var milestones = (window.LOVENA_EDIT_DATA || {}).milestones || [];
      var entry = milestones[idx];
      var heading = milestone.querySelector("strong");
      var date = milestone.querySelector("span:last-child");
      var title = textFor(entry, 0) || (heading && heading.textContent) || "A Chapter in Our Story";
      var copy = textFor(entry, 1) || (milestone.innerText || "").replace(title, "").trim();
      var kicker = textFor(entry, 2) || (date && date.textContent) || "A CHAPTER IN OUR STORY";
      showModal(title, copy, kicker);
      return;
    }

    if (surprise) {
      event.preventDefault();
      event.stopPropagation();
      var kind = surprise.getAttribute("data-surprise");
      if (kind === "gallery") {
        var gallery = document.getElementById("galleryRow");
        if (gallery) gallery.scrollTo({ left: 0, behavior: "smooth" });
        showPhoto(0);
        return;
      }
      var surprises = (window.LOVENA_EDIT_DATA || {}).surprises || {};
      var details = surprises[kind] || {};
      var fallbackTitle = surprise.querySelector("strong");
      var fallbackKicker = surprise.querySelector("small");
      showModal(
        details.title || (fallbackTitle && fallbackTitle.textContent) || "A Note Just for You",
        details.copy || "This little surprise was made especially for you.",
        details.kicker || (fallbackKicker && fallbackKicker.textContent) || "A LITTLE SURPRISE",
        { envelope: kind === "card", signature: kind === "message" ? details.signature : "" }
      );
      return;
    }

    if (action === "modal-prev" || action === "modal-next" || action === "open-gallery") {
      event.preventDefault();
      event.stopPropagation();
      var galleryRow = document.getElementById("galleryRow");
      if (action === "open-gallery" && galleryRow) galleryRow.scrollTo({ left: 0, behavior: "smooth" });
      var step = action === "modal-prev" ? -1 : (action === "modal-next" ? 1 : 0);
      showPhoto(fallbackPhotoIndex + step);
      return;
    }

    if (action === "gallery-left" || action === "gallery-right") {
      var row = document.getElementById("galleryRow");
      if (row) {
        event.preventDefault();
        event.stopPropagation();
        row.scrollBy({ left: (action === "gallery-right" ? 1 : -1) * Math.max(160, row.clientWidth * 0.7), behavior: "smooth" });
      }
      return;
    }

    if (action === "song-love") {
      event.preventDefault();
      event.stopPropagation();
      target.classList.toggle("is-loved");
      return;
    }

    if (action === "song-play") {
      event.preventDefault();
      event.stopPropagation();
      var player = document.getElementById("musicEmbedContainer");
      var link = document.getElementById("musicOpen");
      if (player) {
        player.hidden = false;
        player.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      if (link && link.href) showToast("Use the music link below the player to open the selected song.");
      return;
    }

    if (action === "share-story") {
      event.preventDefault();
      event.stopPropagation();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(window.location.href).then(
          function () { showToast("Link copied to share ♡"); },
          function () { showToast("This experience was made just for you ♡"); }
        );
      } else {
        showToast("This experience was made just for you ♡");
      }
    }
  }

  document.addEventListener("click", handleFallback, true);
})();
