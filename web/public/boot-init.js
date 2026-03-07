// Compute stardate for the boot screen (runs before Svelte loads)
(function () {
    var d = new Date(), y = d.getFullYear();
    var frac = ((d.getTime() - new Date(y, 0, 1).getTime()) / (365.25 * 864e5)).toFixed(1);
    var el = document.getElementById("boot-stardate");
    if (el) el.textContent = (y - 1900) + frac.substring(1);
})();
