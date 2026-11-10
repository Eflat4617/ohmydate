import { ref } from 'vue';
import { defineStore } from 'pinia';

export const useUiStore = defineStore('ui', () => {
  const helpOpen = ref(false);
  const searchOpen = ref(false);
  const newTaskRequest = ref(0);

  function openHelp(): void {
    helpOpen.value = true;
    searchOpen.value = false;
  }

  function openSearch(): void {
    searchOpen.value = true;
    helpOpen.value = false;
  }

  function closeDialogs(): void {
    helpOpen.value = false;
    searchOpen.value = false;
  }

  function requestNewTask(): void {
    newTaskRequest.value += 1;
  }

  return { helpOpen, searchOpen, newTaskRequest, openHelp, openSearch, closeDialogs, requestNewTask };
});
