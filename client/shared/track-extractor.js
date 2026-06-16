/**
 * Чистая логика над снимком таймлайна. fps-агностично: всё в секундах.
 */
(function (global) {
  'use strict';

  function clipsForTrack(snapshot, trackType, trackIndex) {
    var out = [];
    var clips = (snapshot && snapshot.clips) || [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i];
      if (c.trackType === trackType && c.trackIndex === trackIndex) out.push(c);
    }
    out.sort(function (x, y) { return x.startSec - y.startSec; });
    return out;
  }

  /** Время внутри медиа → время секвенции для данного клипа. */
  function mediaToSequenceSec(clip, mediaSec) {
    return clip.startSec + (mediaSec - clip.inPointSec);
  }

  /** Суммарное покрытие дорожки (для выбора опоры). */
  function trackCoverageSec(snapshot, trackType, trackIndex) {
    var clips = clipsForTrack(snapshot, trackType, trackIndex);
    var sum = 0;
    for (var i = 0; i < clips.length; i++) sum += (clips[i].endSec - clips[i].startSec);
    return sum;
  }

  /** Список аудио-дорожек со снимка с их покрытием. */
  function audioTracksWithCoverage(snapshot) {
    var tracks = (snapshot && snapshot.tracks) || [];
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].type === 'audio') {
        out.push({ index: tracks[i].index, name: tracks[i].name,
          coverageSec: trackCoverageSec(snapshot, 'audio', tracks[i].index) });
      }
    }
    return out;
  }

  global.TrackExtractor = {
    clipsForTrack: clipsForTrack,
    mediaToSequenceSec: mediaToSequenceSec,
    trackCoverageSec: trackCoverageSec,
    audioTracksWithCoverage: audioTracksWithCoverage
  };
})(typeof window !== 'undefined' ? window : this);
